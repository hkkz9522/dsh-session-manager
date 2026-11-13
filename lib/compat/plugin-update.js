const successful = new Set(["applied", "restart-required", "refresh-required"]);
const failed = result => !result || !successful.has(result.application) || result.ok === false;
const messageOf = error => typeof error === "string" ? error : error?.message || error?.diagnostic || error?.code || "宿主更新失败";

/** The host owns update/rollback; never start a second install after an uncertain result. */
export async function updateWithHost(pm, { version, baselineVersion, registry, requestId, verify }) {
  const recovery = error => ({ ok: false, status: "recovery-required", code: "recovery-required", error, rolledBack: false });
  const check = async expected => {
    try { return await verify(expected); }
    catch (error) { return { ok: false, error: messageOf(error) }; }
  };
  let outcome;
  try {
    outcome = await pm.updateBundle("dsh-session-manager", version, { requestId, ...(registry ? { registry } : {}) });
  } catch (error) { return recovery("宿主更新中断，需检查安装状态: " + messageOf(error)); }
  if (!outcome?.result || typeof outcome.result.application !== "string") return recovery("宿主返回了无法识别的更新结果");
  if (!successful.has(outcome.result.application) && !["failed", "cancelled"].includes(outcome.result.application)) return recovery("宿主返回了未知的更新应用状态");
  if (!failed(outcome.result)) {
    const verified = await check(version);
    if (!verified.ok) return recovery("安装后校验失败: " + verified.error);
    return { ok: true, status: "completed", application: outcome.result.application, version: verified.version || version };
  }
  const error = messageOf(outcome.result.error);
  if (outcome.restore !== undefined) {
    if (failed(outcome.restore)) return recovery(error + "；宿主恢复旧版本失败: " + messageOf(outcome.restore.error));
    const restored = await check(baselineVersion);
    if (!restored.ok) return recovery(error + "；恢复旧版本后校验失败: " + restored.error);
    return { ok: false, status: "rolled-back", code: "install-failed", error: error + "（宿主已恢复旧版本）", rolledBack: true };
  }
  const unchanged = await check(baselineVersion);
  if (!unchanged.ok) return recovery(error + "；当前安装状态无法确认: " + unchanged.error);
  return { ok: false, status: "failed", code: "install-failed", error, rolledBack: false };
}
