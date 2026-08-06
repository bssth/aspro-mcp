import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from the package root, regardless of cwd. Claude Code launches the
// server from C:\ on Windows, so cwd-relative loading would miss it. Note that
// when the package is run via `npx`, the package root lives inside the npm
// cache — there is no .env there, so npx users must pass `env` in their MCP
// client config instead. dotenv never overrides variables already in the
// environment, so the client-provided values always win.
loadEnv({ path: resolve(__dirname, "..", ".env") });

export interface AsproConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  /** When true, mutating operations are refused before any request is made. */
  readOnly: boolean;
  /** Soft cap on the serialized size of a single tool result. */
  maxResponseChars: number;
}

export type ConfigResult =
  | { ok: true; config: AsproConfig }
  | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_CHARS = 60_000;

function parseBoolean(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

/**
 * Read configuration from the environment. Never throws — a missing API key is
 * returned as an error so the server can still start and serve the offline
 * discovery tools, which need no credentials.
 */
export function loadConfig(): ConfigResult {
  try {
    const apiKey = process.env.ASPRO_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error:
          "ASPRO_API_KEY is not set. Set it in the MCP client config (`env` block) " +
          "or copy .env.example to .env in the package root.",
      };
    }

    let baseUrl = process.env.ASPRO_BASE_URL;
    if (!baseUrl) {
      const company = process.env.ASPRO_COMPANY;
      if (!company) {
        return {
          ok: false,
          error: "Either ASPRO_BASE_URL or ASPRO_COMPANY must be set in the environment.",
        };
      }
      baseUrl = `https://${company}.aspro.cloud/api/v1/module`;
    }
    baseUrl = baseUrl.replace(/\/+$/, "");

    return {
      ok: true,
      config: {
        baseUrl,
        apiKey,
        timeoutMs: parsePositiveInt(process.env.ASPRO_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "ASPRO_TIMEOUT_MS"),
        readOnly: parseBoolean(process.env.ASPRO_READ_ONLY),
        maxResponseChars: parsePositiveInt(
          process.env.ASPRO_MAX_RESPONSE_CHARS,
          DEFAULT_MAX_RESPONSE_CHARS,
          "ASPRO_MAX_RESPONSE_CHARS",
        ),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
