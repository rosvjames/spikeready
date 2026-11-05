import { loadDotEnv, loadPayPalConfig } from "../config.js";
import { PayPalClient, type PayPalClientOptions } from "./client.js";

/** Client from environment variables (or a local .env). Throws MissingConfigError naming what is missing. */
export function clientFromEnv(opts: PayPalClientOptions = {}): PayPalClient {
  loadDotEnv();
  return new PayPalClient(loadPayPalConfig(), opts);
}
