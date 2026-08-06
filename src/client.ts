import type { AsproConfig } from "./config.js";
import type { OperationSpec } from "./spec.js";

export interface CallOptions {
  /** Path parameter: usually the entity id for `/get/{id}`, `/update/{id}`, etc. */
  id?: string | number;
  /** Query parameters (excluding api_key, which is added automatically). */
  query?: Record<string, unknown>;
  /** Request body fields — sent form-urlencoded for POSTs. */
  body?: Record<string, unknown>;
}

export interface CallResult {
  status: number;
  ok: boolean;
  /** Request URL with the API key redacted — this value is shown to the model. */
  url: string;
  /** Parsed JSON when the response is JSON, otherwise the raw body text. */
  data: unknown;
  truncated?: TruncationInfo;
}

export interface TruncationInfo {
  reason: string;
  hint: string;
  returnedItems?: number;
  totalItems?: number;
}

export const REDACTED = "***REDACTED***";

export class AsproClient {
  constructor(private readonly config: AsproConfig) {}

  /**
   * Call an Aspro endpoint described by `op`. Substitutes path params from
   * `opts.id` (or `opts.query`/`opts.body` for non-id path vars), appends
   * `api_key`, and sends GET or POST per the spec.
   */
  async call(op: OperationSpec, opts: CallOptions = {}): Promise<CallResult> {
    const url = this.buildUrl(op, opts);
    const safeUrl = redactApiKey(url);
    const init: RequestInit = {
      method: op.httpMethod.toUpperCase(),
      headers: { Accept: "application/json" },
    };

    if (op.httpMethod === "post") {
      const form = new URLSearchParams();
      const body = opts.body ?? {};
      for (const [k, v] of Object.entries(body)) {
        appendFormValue(form, k, v);
      }
      init.body = form.toString();
      (init.headers as Record<string, string>)["Content-Type"] =
        "application/x-www-form-urlencoded";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    init.signal = controller.signal;

    let response: Response;
    let rawBody: string;
    try {
      response = await fetch(url, init);
      // Reading the body stays inside the timeout window: a response that
      // starts fast but streams slowly must still be abortable.
      rawBody = await response.text();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Never let the raw URL into the error message — it carries the API key.
      throw new Error(`Request failed: ${op.httpMethod.toUpperCase()} ${safeUrl} — ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    // Non-JSON bodies stay as text in `data`. Previously the raw body was also
    // returned alongside the parsed data, sending every successful payload to
    // the model twice; `data` alone now carries it.
    let data: unknown = rawBody;
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("application/json") && rawBody.length > 0) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        // Keep raw text if JSON parse fails.
      }
    }

    const { value, truncated } = capResponseSize(data, this.config.maxResponseChars);

    return {
      status: response.status,
      ok: response.ok,
      url: safeUrl,
      data: value,
      truncated,
    };
  }

  private buildUrl(op: OperationSpec, opts: CallOptions): string {
    let path = op.path;
    const pathVars = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const usedFromQuery = new Set<string>();

    for (const v of pathVars) {
      let raw: unknown;
      if (v === "id" && opts.id !== undefined) {
        raw = opts.id;
      } else if (opts.query && v in opts.query) {
        raw = opts.query[v];
        usedFromQuery.add(v);
      } else if (opts.body && v in opts.body) {
        raw = opts.body[v];
      } else {
        throw new Error(
          `Missing path parameter "${v}" for ${op.httpMethod.toUpperCase()} ${op.path}`,
        );
      }
      path = path.replace(`{${v}}`, encodeURIComponent(String(raw)));
    }

    const url = new URL(`${this.config.baseUrl}${path}`);
    url.searchParams.set("api_key", this.config.apiKey);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (usedFromQuery.has(k) || v === undefined || v === null) continue;
        appendQueryValue(url.searchParams, k, v);
      }
    }
    return url.toString();
  }
}

/** Strip the api_key value from a URL so it never reaches the model or logs. */
export function redactApiKey(url: string): string {
  return url.replace(/([?&]api_key=)[^&]*/gi, `$1${REDACTED}`);
}

/**
 * Keep a single tool result from swallowing the model's context. Paginated
 * payloads lose trailing items (with a note saying how many were dropped);
 * anything else falls back to a hard character cut.
 */
export function capResponseSize(
  data: unknown,
  maxChars: number,
): { value: unknown; truncated?: TruncationInfo } {
  const serialized = safeStringify(data);
  if (serialized.length <= maxChars) return { value: data };

  const items = (data as any)?.response?.items;
  if (Array.isArray(items) && items.length > 0) {
    const totalItems = items.length;
    let kept = totalItems;
    let candidate = data;
    // Halve until it fits — cheaper than re-serializing per removed item.
    while (kept > 1) {
      kept = Math.floor(kept / 2);
      candidate = {
        ...(data as object),
        response: { ...(data as any).response, items: items.slice(0, kept) },
      };
      if (safeStringify(candidate).length <= maxChars) break;
    }
    return {
      value: candidate,
      truncated: {
        reason: `Response exceeded ASPRO_MAX_RESPONSE_CHARS (${maxChars}).`,
        hint:
          "Only the first items are shown. Narrow the request with query parameters " +
          "(e.g. paging) or fetch a single record with the `get` method.",
        returnedItems: kept,
        totalItems,
      },
    };
  }

  return {
    value: `${serialized.slice(0, maxChars)}…`,
    truncated: {
      reason: `Response exceeded ASPRO_MAX_RESPONSE_CHARS (${maxChars}).`,
      hint: "Output was cut mid-payload and is no longer valid JSON. Request a narrower result set.",
    },
  };
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function appendFormValue(form: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendFormValue(form, `${key}[]`, item);
    return;
  }
  if (typeof value === "object") {
    form.append(key, JSON.stringify(value));
    return;
  }
  form.append(key, String(value));
}

function appendQueryValue(params: URLSearchParams, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(params, `${key}[]`, item);
    return;
  }
  if (typeof value === "object") {
    params.append(key, JSON.stringify(value));
    return;
  }
  params.append(key, String(value));
}
