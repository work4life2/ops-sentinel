import { setting } from "../env.js";
import { amount } from "../format.js";
import { fetchJson, pickNumber } from "../http.js";
import type { CheckConfig, Probe } from "../types.js";

/**
 * OpenRouter: account credits left (GET /api/v1/credits, account-wide) and the key's own limit
 * (GET /api/v1/key). The tighter of the two is the metric.
 */
export async function openrouter(cfg: CheckConfig): Promise<Probe> {
  const base = (setting(cfg, "baseUrl", true) ?? "https://openrouter.ai/api").replace(/\/+$/, "").replace(/\/v1$/, "");
  const headers = { authorization: `Bearer ${setting(cfg, "apiKey")}` };
  const [credits, key] = await Promise.all([
    fetchJson(`${base}/v1/credits`, { headers }),
    fetchJson(`${base}/v1/key`, { headers }),
  ]);

  const total = pickNumber(credits, "data.total_credits");
  const used = pickNumber(credits, "data.total_usage");
  if (total === undefined || used === undefined) throw new Error("/credits 返回里没有 total_credits/total_usage");
  const left = Math.max(0, total - used);

  const details = [`累计充值 ${amount(total, "USD")}，已用 ${amount(used, "USD")}`];
  const daily = pickNumber(key, "data.usage_daily");
  const weekly = pickNumber(key, "data.usage_weekly");
  const monthly = pickNumber(key, "data.usage_monthly");
  if (daily !== undefined) {
    details.push(`本 key 今天 ${amount(daily, "USD")}，本周 ${amount(weekly ?? 0, "USD")}，本月 ${amount(monthly ?? 0, "USD")}`);
  }

  const keyLimit = pickNumber(key, "data.limit");
  const keyLeft = pickNumber(key, "data.limit_remaining");
  if (keyLimit !== undefined && keyLeft !== undefined && keyLeft < left) {
    details.push(`按 key 限额计（账户余额 ${amount(left, "USD")}）`);
    return { metric: { value: keyLeft, limit: keyLimit, unit: "USD" }, note: details.join("；") };
  }
  return { metric: { value: left, unit: "USD" }, note: details.join("；") };
}
