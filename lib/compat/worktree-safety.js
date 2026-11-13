import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getService } from "./dsh-adapter.js";

function refuse(message, code = "worktree-move-unsupported") {
  throw Object.assign(new Error(message), { code });
}

/** Read-only admission: conversation rehoming cannot rebind Git ownership. */
export async function assertWorktreeMoveSafe(ctx, id, header, content) {
  let cwd = header.cwd;
  let linked = false;
  let packed = false;
  for (const line of content.split("\n").slice(1)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; } // mutator validates the log separately
    if (event?.type === "plugin:worktree/created") linked = true;
    if (event?.type === "working-directory/change" && typeof event.data?.cwd === "string") cwd = event.data.cwd;
    if (!Number.isInteger(event?.seq)) packed = true;
  }
  if (getService(ctx, "worktrees") && !linked) {
    const projections = getService(ctx, "sessionProjections");
    const query = getService(ctx, "sessionQuery");
    const live = getService(ctx, "sessions")?.get?.(id);
    let snapshot;
    if (typeof projections?.snapshot === "function") {
      if (live) snapshot = projections.snapshot(live, ["worktree", "workingDirectory"]);
      else if (typeof query?.inspectSession === "function") snapshot = await query.inspectSession(id, session => projections.snapshot(session, ["worktree", "workingDirectory"]));
    }
    if (snapshot) {
      const creations = snapshot.values?.worktree;
      if (!Array.isArray(creations)) refuse("无法确认会话的 Git Worktree 关联，未移动会话", "worktree-state-unavailable");
      linked = creations.length > 0;
      if (typeof snapshot.values?.workingDirectory === "string") cwd = snapshot.values.workingDirectory;
    } else if (packed) refuse("无法安全解析会话的 Git Worktree 关联，未移动会话", "worktree-state-unavailable");
  }
  if (!linked && typeof cwd === "string" && isAbsolute(cwd)) {
    try {
      const git = await lstat(join(cwd, ".git"));
      // Linked worktrees and submodules both use a .git indirection file.
      linked = git.isFile() || git.isSymbolicLink();
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
  }
  if (linked) refuse("会话关联 Git Worktree 或独立 Git 目录，无法安全跨工作区重绑定；会话和工作树均未移动");
}
