// Public API of "Ask SpikeReady" (for the panel and the CLI).
export { CodeAssistant, type AskMode, type AskRequest, type AskResult, type Assistant, type Attachment } from "./agent.js";
export { compose, INTENTS, SUGGESTIONS, type Intent } from "./answers.js";
export { checkClaims, type CheckedClaim, type Claim, type ClaimCheck } from "./claims.js";
export { AnthropicIntentReader, KeywordIntentReader, type IntentReader } from "./intent.js";
export { READ_TOOL_NAMES } from "./tools.js";

import { aiConfigured } from "../ai/client.js";
import type { McpContext } from "../mcp/tools.js";
import { CodeAssistant } from "./agent.js";
import { AnthropicIntentReader, KeywordIntentReader } from "./intent.js";

/** Claude understands typed questions when live AI is allowed and configured; otherwise keywords do. */
export function createAssistant(ctx: McpContext, opts: { live: boolean; env?: NodeJS.ProcessEnv }): CodeAssistant {
  return new CodeAssistant(ctx, opts.live && aiConfigured(opts.env ?? process.env) ? new AnthropicIntentReader() : new KeywordIntentReader());
}
