import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitSessionStep, closeSessionWriters, sessionWriters } from '../lib/compat/session-lifecycle.js';
import { updateWithHost } from '../lib/compat/plugin-update.js';
import { assertWorktreeMoveSafe } from '../lib/compat/worktree-safety.js';

test('teardown timeout rejects instead of authorizing deletion', async () => {
  await assert.rejects(awaitSessionStep(new Promise(() => {}), 'stop', 5), { code: 'session-teardown-timeout' });
});

test('writer collection deduplicates direct handles and includes only target writers', () => {
  const target = { id: 's1', access: 'write' };
  assert.deepEqual(sessionWriters({ tracker: { writers: new Map([['s1', target]]), openHandles: new Set([target, { id: 's1', access: 'read' }, { id: 's2', access: 'write' }]) } }, 's1'), [target]);
});

test('old coordinator retirement is awaited and an unreleased owner is refused', async () => {
  let release;
  const retired = new Promise(resolve => { release = resolve; });
  const states = new Map([['s1', { owner: {} }]]);
  const operation = closeSessionWriters({ coordinator: { retirements: new Map([['s1', retired]]), states } }, 's1', []);
  states.delete('s1');
  release();
  await operation;
  states.set('s1', { owner: {} });
  await assert.rejects(closeSessionWriters({ coordinator: { states } }, 's1', []), { code: 'session-writer-still-owned' });
});

test('missing writer close surface fails explicitly', async () => {
  await assert.rejects(closeSessionWriters({}, 's1', [{}]), { code: 'session-writer-close-unavailable' });
});

for (const scenario of ['throw', 'malformed', 'restore-failed', 'restore-unverified']) {
  test(`native update ${scenario} requires recovery without a second installer`, async () => {
    const result = await updateWithHost({ async updateBundle() {
      if (scenario === 'throw') throw new Error('lost connection');
      if (scenario === 'malformed') return {};
      return { result: { application: 'failed', error: { diagnostic: 'install failed' } }, restore: { application: scenario === 'restore-failed' ? 'failed' : 'applied' } };
    } }, { version: '9.0.0', baselineVersion: '1.0.0', requestId: 'test', verify: async () => ({ ok: false, error: 'invalid' }) });
    assert.equal(result.status, 'recovery-required');
    assert.equal(result.rolledBack, false);
  });
}

test('native refusal with a verified old installation is a failure, not a rollback', async () => {
  const result = await updateWithHost({ async updateBundle() { return { result: { application: 'failed', error: 'refused' } }; } }, {
    version: '9.0.0', baselineVersion: '1.0.0', verify: async expected => ({ ok: expected === '1.0.0' })
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.rolledBack, false);
});

test('cold Worktree projection is inspected before allowing a move', async () => {
  let inspected = false;
  const services = { worktrees: {}, sessionQuery: { async inspectSession(id, inspect) { inspected = id === 's1'; return inspect({}); } }, sessionProjections: { snapshot: () => ({ values: { worktree: [{ owned: false, worktree: { path: '/checkout' } }] } }) } };
  await assert.rejects(assertWorktreeMoveSafe({ get: key => services[key] }, 's1', { cwd: '/not-present' }, '{}\n'), { code: 'worktree-move-unsupported' });
  assert.equal(inspected, true);
});

test('packed histories without a reliable Worktree projection are refused when the provider is active', async () => {
  await assert.rejects(assertWorktreeMoveSafe({ get: key => key === 'worktrees' ? {} : undefined }, 's1', {}, '{}\n{"packed":true}\n'), { code: 'worktree-state-unavailable' });
});

test('native updater refuses unknown application states and malformed restore results', async () => {
  for (const outcome of [
    { result: { application: 'mystery' } },
    { result: { application: 'failed' }, restore: {} }
  ]) {
    const result = await updateWithHost({ updateBundle: async () => outcome }, { version: '2.0.0', baselineVersion: '1.0.0', verify: async () => ({ ok: true }) });
    assert.equal(result.status, 'recovery-required');
    assert.equal(result.rolledBack, false);
  }
});
