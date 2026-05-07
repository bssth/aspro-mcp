import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the project root, regardless of cwd. Claude Code launches
// the server from C:\ on Windows, so cwd-relative loading would miss it.
loadEnv({ path: resolve(__dirname, "..", ".env") });

export interface AsproConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export function loadConfig(): AsproConfig {
  const apiKey = process.env.ASPRO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ASPRO_API_KEY is not set. Copy .env.example to .env and fill it in.",
    );
  }

  let baseUrl = process.env.ASPRO_BASE_URL;
  if (!baseUrl) {
    const company = process.env.ASPRO_COMPANY;
    if (!company) {
      throw new Error(
        "Either ASPRO_BASE_URL or ASPRO_COMPANY must be set in the environment.",
      );
    }
    baseUrl = `https://${company}.aspro.cloud/api/v1/module`;
  }
  baseUrl = baseUrl.replace(/\/+$/, "");

  const timeoutRaw = process.env.ASPRO_TIMEOUT_MS;
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 30_000;
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid ASPRO_TIMEOUT_MS: ${timeoutRaw}`);
  }

  return { baseUrl, apiKey, timeoutMs };
}
