import { setting } from "../env.js";
import { ago, amount } from "../format.js";
import { fetchJson, pickNumber } from "../http.js";
import { NotConfiguredError, type CheckConfig, type Probe } from "../types.js";

/**
 * Mobula: credits used this billing period via GET /api/2/usage?source=api (the key plus one of
 * organizationId / customerId from admin.mobula.io → settings). Mobula does not report a balance, so
 * remaining = `monthlyCredits` (the plan: Startup 125k, Growth 1.25M) − used since `billingDay`.
 * Past the allowance Mobula bills overage automatically, which is why this is worth an alert.
 * The usage call itself costs a credit, so give this check a "minIntervalMinutes" (60 in ops.config.json).
 */
export async function mobula(cfg: CheckConfig): Promise<Probe> {
  const base = (setting(cfg, "baseUrl", true) ?? "https://api.mobula.io/api").replace(/\/+$/, "");
  const apiKey = setting(cfg, "apiKey");
  const organizationId = setting(cfg, "organizationId", true);
  const customerId = setting(cfg, "customerId", true);
  if (!organizationId && !customerId) throw new NotConfiguredError("需要 organizationId 或 customerId（admin.mobula.io 设置页）");
  const monthly = Number(setting(cfg, "monthlyCredits"));
  if (!Number.isFinite(monthly) || monthly <= 0) throw new NotConfiguredError("monthlyCredits 要填套餐每月额度");

  const from = periodStart(new Date(), Number(setting(cfg, "billingDay", true) ?? 1));
  // 100 hourly rows (newest first) is enough to find the last real use within idleWarnHours.
  const qs = new URLSearchParams({ source: "api", apiKey, from: from.toISOString(), limit: "100" });
  if (organizationId) qs.set("organizationId", organizationId);
  else qs.set("customerId", customerId!);
  const res = await fetchJson(`${base}/2/usage?${qs}`, { headers: { authorization: apiKey } });
  if (res?.success === false) throw new Error(`Mobula: ${res.error ?? "unknown"}`);

  const used = pickNumber(res, "data.totals.credits");
  if (used === undefined) throw new Error("返回里没有 data.totals.credits");
  const calls = pickNumber(res, "data.totals.requestCalls");
  const left = monthly - used;
  // Our own monitoring calls are billed and counted too; the last *real* use is the newest hour with
  // any other endpoint.
  const rows = (res?.data?.rows ?? []) as { timestamp: string; metrics?: Record<string, number> }[];
  const lastAt = rows.find((r) => Object.keys(r.metrics ?? {}).some((m) => !MONITORING.has(m.replace(/:calls$/, ""))))?.timestamp;
  const idleHours = Number(setting(cfg, "idleWarnHours", true) ?? 48);
  const days = Math.max(1, (Date.now() - from.getTime()) / 86_400_000);
  const note = [
    `本期（${from.toISOString().slice(5, 10)} 起）已用 ${amount(used, "credits")}${calls !== undefined ? `，${calls.toLocaleString("en-US")} 次请求` : ""}，日均 ${Math.round(used / days).toLocaleString("en-US")}`,
    lastAt ? `最近使用 ${ago(lastAt)}` : "本期没有使用",
  ].join("；");
  const warnings: string[] = [];
  if (left < 0) warnings.push(`Mobula 本期已超出套餐 ${amount(-left, "credits")}，超出部分会自动按量计费`);
  // The Termix backend falls back to GeckoTerminal silently when Mobula fails, so silence is the symptom.
  if (!lastAt || Date.now() - Date.parse(lastAt) > idleHours * 3600_000) {
    const since = lastAt ? `最近一次调用在 ${ago(lastAt)}` : "本期一次都没调用";
    warnings.push(`Mobula ${since}：Termix 后端的 K 线可能已悄悄退回 GeckoTerminal（key 没进生产环境，或被 401/402/403 暂停）`);
  }
  return { metric: { value: left, limit: monthly, unit: "credits" }, note, warnings };
}

/** Endpoints this check (and its token probe) call: they cost credits but are not real usage. */
const MONITORING = new Set(["/api/2/usage", "/api/2/auth/tokens"]);

/** Start of the current billing period, given the day of month it renews on (UTC). */
export function periodStart(now: Date, billingDay: number): Date {
  const day = Math.min(Math.max(1, Math.floor(billingDay)), 28);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  if (start > now) start.setUTCMonth(start.getUTCMonth() - 1);
  return start;
}
