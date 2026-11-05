import { loadDotEnv, loadPayPalConfig } from "../config.js";
import { PayPalClient } from "./client.js";

/** Client from environment variables (or a local .env). Throws MissingConfigError naming what is missing. */
export function clientFromEnv(): PayPalClient {
  loadDotEnv();
  return new PayPalClient(loadPayPalConfig());
}
