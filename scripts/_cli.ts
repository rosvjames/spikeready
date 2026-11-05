import { MissingConfigError } from "../src/config.js";
import { PayPalApiError } from "../src/paypal/client.js";

/** Runs a script with readable errors (never prints secrets). */
export function run(main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    if (err instanceof MissingConfigError) console.error(`\n${err.message}`);
    else if (err instanceof PayPalApiError) console.error(`\n${err.message}`);
    else console.error(err);
    process.exit(1);
  });
}

export const pad = (s: string | number, n: number) => String(s).padEnd(n);
