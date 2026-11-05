// Claude client: the Anthropic API directly (ANTHROPIC_API_KEY), or the Astropods AI Gateway (a
// hackathon sponsor) when ASTRO_GATEWAY_URL and ASTRO_GATEWAY_API_KEY are set. The gateway passes the
// native Messages API through at /anthropic and authenticates with the x-bf-vk header
// (docs.astropods.com/ai-gateway/anthropic). An Anthropic key is never sent to the gateway.
import Anthropic from "@anthropic-ai/sdk";

export type AiBackend = "anthropic" | "astropods";

export function aiBackend(env: NodeJS.ProcessEnv = process.env): AiBackend | null {
  if (env.ASTRO_GATEWAY_URL && env.ASTRO_GATEWAY_API_KEY) return "astropods";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

/** True when some Claude backend is configured. */
export const aiConfigured = (env: NodeJS.ProcessEnv = process.env): boolean => aiBackend(env) !== null;

export function makeAnthropicClient(env: NodeJS.ProcessEnv = process.env): Anthropic {
  if (aiBackend(env) === "astropods") {
    const key = env.ASTRO_GATEWAY_API_KEY!;
    return new Anthropic({
      baseURL: `${env.ASTRO_GATEWAY_URL!.replace(/\/+$/, "")}/anthropic`,
      apiKey: null,
      authToken: key,
      defaultHeaders: { "x-bf-vk": key },
      maxRetries: 3,
    });
  }
  return new Anthropic({ maxRetries: 3 });
}
