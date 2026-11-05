// Public API of "Ask SpikeReady" (for the panel and the CLI).
export { ASSISTANT_MODEL, LiveAssistant, type AskMode, type AskRequest, type AskResult, type Assistant, type Attachment, type LiveAssistantOptions } from "./agent.js";
export { checkClaims, type CheckedClaim, type Claim, type ClaimCheck } from "./claims.js";
export { RECORDED_ASSISTANT_FILE, RecordedAssistant, type RecordedAnswer, type RecordedAssistantFile } from "./recorded.js";
export { ASSISTANT_TOOLS, READ_TOOL_NAMES } from "./tools.js";

import { aiConfigured } from "../ai/client.js";
import type { McpContext } from "../mcp/tools.js";
import { LiveAssistant, type Assistant, type LiveAssistantOptions } from "./agent.js";
import { RecordedAssistant } from "./recorded.js";

/**
 * The assistant to use: live when an AI backend is configured and `live` is allowed (the server's
 * aiUploadsEnabled rule), otherwise the recorded demo answers, or null when neither is available.
 */
export function createAssistant(ctx: McpContext, opts: { live: boolean; env?: NodeJS.ProcessEnv } & LiveAssistantOptions): Assistant | null {
  if (opts.live && aiConfigured(opts.env ?? process.env)) return new LiveAssistant(ctx, opts);
  return RecordedAssistant.fromFile();
}
