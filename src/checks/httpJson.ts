import { interpolate, setting } from "../env.js";
import { amount } from "../format.js";
import { fetchJson, headersFrom, pickNumber } from "../http.js";
import type { CheckConfig, Probe } from "../types.js";

/**
 * Any provider with a JSON balance endpoint, configured without code (Suno resellers, Mobula, ...):
 *   "url", optional "method"/"body"/"auth"/"headers",
 *   "remainingPath" (or "limitPath" + "usedPath"), optional "limitPath", "unit", "scale".
 * `scale` multiplies every number read (e.g. 0.01 to turn cents into USD); `usdPerUnit` adds a "≈$" hint.
 */
export async function httpJson(cfg: CheckConfig): Promise<Probe> {
  const url = setting(cfg, "url");
  const body = cfg.body === undefined ? undefined : JSON.parse(interpolate(JSON.stringify(cfg.body)));
  const res = await fetchJson(url, {
    method: setting(cfg, "method", true),
    headers: headersFrom(cfg),
    body,
  });

  const scale = Number(cfg.scale ?? 1);
  const unit = setting(cfg, "unit", true) ?? "credits";
  const read = (key: string) => {
    const path = setting(cfg, key, true);
    if (!path) return undefined;
    const n = pickNumber(res, path);
    if (n === undefined) throw new Error(`返回里没有数字字段 ${path}`);
    return n * scale;
  };

  const limit = read("limitPath");
  const used = read("usedPath");
  let remaining = read("remainingPath");
  if (remaining === undefined) {
    if (limit === undefined || used === undefined) throw new Error("需要 remainingPath，或 limitPath + usedPath");
    remaining = limit - used;
  }

  const usdPerUnit = Number(cfg.usdPerUnit ?? 0);
  const display = usdPerUnit > 0 ? `${amount(remaining, unit)} (≈${amount(remaining * usdPerUnit, "USD")})` : undefined;
  return { metric: { value: remaining, limit, unit, display }, note: used !== undefined ? `已用 ${amount(used, unit)}` : undefined };
}
