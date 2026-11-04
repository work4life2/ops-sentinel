import { interpolate } from "./env.js";
import { AuthError, NotConfiguredError } from "./types.js";

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/** GET/POST a JSON endpoint. 401/403 become AuthError so the runner backs off (fail2ban bans repeat 401s). */
export async function fetchJson<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    // undici reports every network problem as "fetch failed"; the cause says which one.
    const e = err as Error & { cause?: { code?: string; message?: string } };
    if (e.name === "TimeoutError") throw new Error(`请求超时 ${new URL(url).host}`);
    const cause = e.cause?.code ?? e.cause?.message;
    throw new Error(`连不上 ${new URL(url).host}${cause ? `（${cause}）` : ""}`);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`HTTP ${res.status}（凭据被拒绝）${text ? `: ${snippet(errorText(text))}` : ""}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${snippet(errorText(text))}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`返回的不是 JSON: ${snippet(text)}`);
  }
}

/** The human-readable part of a JSON error body ({error}, {message}, {detail}), else the raw text. */
function errorText(text: string): string {
  try {
    const j = JSON.parse(text);
    const msg = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail;
    if (typeof msg === "string") return msg;
  } catch {
    // not JSON
  }
  return text;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

/**
 * Build request headers from a check config:
 *   "auth": { "type": "bearer", "token": "${KEY}" } | { "type": "basic", "user": "...", "pass": "${PW}" }
 *   "headers": { "X-Api-Key": "${KEY}" }
 */
export function headersFrom(cfg: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const auth = cfg.auth as Record<string, string> | undefined;
  if (auth) {
    if (auth.type === "bearer") out.authorization = `Bearer ${interpolate(auth.token ?? "")}`;
    else if (auth.type === "basic") {
      const pair = `${interpolate(auth.user ?? "")}:${interpolate(auth.pass ?? "")}`;
      out.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    } else throw new NotConfiguredError(`未知的 auth.type: ${auth.type}`);
  }
  const extra = cfg.headers as Record<string, string> | undefined;
  for (const [k, v] of Object.entries(extra ?? {})) out[k.toLowerCase()] = interpolate(v);
  return out;
}

/** Read a dotted path ("data.credits.left", "items.0.value") from parsed JSON. */
export function pick(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Same as pick() but requires a finite number (strings like "12.5" are accepted). */
export function pickNumber(obj: unknown, path: string): number | undefined {
  const v = pick(obj, path);
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}
