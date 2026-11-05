// Environment loading. Secrets come only from environment variables (or a local, git-ignored .env).
// Error messages name the missing variables but never print values.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const ROOT = join(import.meta.dirname, "..");

/** Loads ROOT/.env into process.env without overriding variables that are already set. */
export function loadDotEnv(path = join(ROOT, ".env")): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !m[2]) continue;
    const [, key, raw] = m;
    if (process.env[key!] === undefined) process.env[key!] = raw!.replace(/^["']|["']$/g, "");
  }
}

const PayPalEnv = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
});

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  env: "sandbox" | "live";
  baseUrl: string;
}

export const PAYPAL_BASE_URL = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

export class MissingConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing environment variables: ${missing.join(", ")}. Set them as environment secrets or in a local .env (see .env.example).`);
    this.name = "MissingConfigError";
  }
}

export function loadPayPalConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  const parsed = PayPalEnv.safeParse(env);
  if (!parsed.success) {
    const missing = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new MissingConfigError(missing);
  }
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV } = parsed.data;
  return { clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, env: PAYPAL_ENV, baseUrl: PAYPAL_BASE_URL[PAYPAL_ENV] };
}
