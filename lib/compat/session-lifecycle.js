/** Bounded completion is a prerequisite for destructive work, never success. */
export async function awaitSessionStep(operation, label, timeoutMs = 3000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${label}超时，已停止后续删除`), { code: "session-teardown-timeout" })), timeoutMs);
      })
    ]);
  } finally { clearTimeout(timer); }
}

/** Snapshot before detach: disposed starts asynchronous close, but does not await it.
 * openHandles also contains writers whose retirement has already started.
 */
export function sessionWriters(persistence, id) {
  const writers = new Set();
  const direct = persistence?.tracker?.writers?.get?.(id);
  if (direct) writers.add(direct);
  const handles = persistence?.tracker?.openHandles;
  if (handles && typeof handles[Symbol.iterator] === "function") {
    for (const handle of handles) if (handle.id === id && handle.access === "write") writers.add(handle);
  }
  return [...writers];
}

export async function closeSessionWriters(persistence, id, writers) {
  for (const writer of new Set(writers)) {
    if (typeof writer.close !== "function") throw Object.assign(new Error("宿主未提供可等待的会话写入关闭接口，会话文件未删除"), { code: "session-writer-close-unavailable" });
    await awaitSessionStep(writer.close(), `关闭会话 '${id}' 写入`);
  }
  const retirement = persistence?.coordinator?.retirements?.get?.(id);
  if (retirement) await awaitSessionStep(retirement, `等待会话 '${id}' 持久化退休`);
  if (persistence?.coordinator?.states?.get?.(id)?.owner !== undefined) {
    throw Object.assign(new Error(`会话 '${id}' 仍有持久化写入 owner，未删除文件`), { code: "session-writer-still-owned" });
  }
}
