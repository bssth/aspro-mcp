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
  url: string;
  data: unknown;
  rawBody?: string;
}

export class AsproClient {
  constructor(private readonly config: AsproConfig) {}

  /**
   * Call an Aspro endpoint described by `op`. Substitutes path params from
   * `opts.id` (or `opts.query`/`opts.body` for non-id path vars), appends
   * `api_key`, and sends GET or POST per the spec.
   */
  async call(op: OperationSpec, opts: CallOptions = {}): Promise<CallResult> {
    const url = this.buildUrl(op, opts);
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
    try {
      response = await fetch(url, init);
    } catch (err) {
      clearTimeout(timer);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Request failed: ${op.httpMethod.toUpperCase()} ${url} — ${reason}`);
    }
    clearTimeout(timer);

    const rawBody = await response.text();
    let data: unknown = rawBody;
    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("application/json") && rawBody.length > 0) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        // Keep raw text if JSON parse fails.
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      url,
      data,
      rawBody: typeof data === "string" ? undefined : rawBody.length > 0 ? rawBody : undefined,
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
