import { setting } from "../env.js";
import { fetchJson, headersFrom, pick } from "../http.js";
import { AuthError, type CheckConfig, type Probe } from "../types.js";

/**
 * Liveness of an HTTP JSON endpoint. Unreachable / non-2xx / `okPath` falsy → crit.
 * `fields`: [{ "path": "sessions", "label": "在线局数" }] adds values to the summary.
 */
export async function httpHealth(cfg: CheckConfig): Promise<Probe> {
  const url = setting(cfg, "url");
  const started = Date.now();
  let body: unknown;
  try {
    body = await fetchJson(url, { headers: headersFrom(cfg), timeoutMs: Number(cfg.timeoutMs ?? 10_000) });
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return { level: "crit", headline: `不可用：${(err as Error).message}` };
  }
  const ms = Date.now() - started;
  const okPath = setting(cfg, "okPath", true);
  if (okPath && !pick(body, okPath)) return { level: "crit", headline: `返回 ${okPath} 不为真` };

  const fields = (cfg.fields as { path: string; label: string }[] | undefined) ?? [];
  const extras = fields.map((f) => `${f.label} ${String(pick(body, f.path) ?? "?")}`);
  return { level: "ok", headline: `在线 ${ms}ms`, note: extras.join("，") || undefined };
}
