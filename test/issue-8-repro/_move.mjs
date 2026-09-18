// Shared test/reproduction entry point. Call the real production HTTP handler,
// not a frozen copy of moveSession or its filesystem helpers.
import { mountPlugin } from "../helpers/plugin-harness.mjs";

export async function moveSession(ctx, sessionId, targetWorkspaceId) {
  const response = await mountPlugin(ctx).request("/move", { sessionId, targetWorkspaceId });
  if (!response.data.ok) throw new Error(response.data.error);
  return response.data.result;
}
