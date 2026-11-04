import { setting } from "../env.js";
import { amount } from "../format.js";
import { fetchJson, pickNumber } from "../http.js";
import type { CheckConfig, Probe } from "../types.js";

/** Runway API credits: GET /v1/organization → creditBalance (1 credit = $0.01). */
export async function runway(cfg: CheckConfig): Promise<Probe> {
  const base = (setting(cfg, "baseUrl", true) ?? "https://api.dev.runwayml.com").replace(/\/+$/, "");
  const org = await fetchJson(`${base}/v1/organization`, {
    headers: {
      authorization: `Bearer ${setting(cfg, "apiKey")}`,
      "x-runway-version": setting(cfg, "apiVersion", true) ?? "2024-11-06",
    },
  });
  const credits = pickNumber(org, "creditBalance");
  if (credits === undefined) throw new Error("返回里没有 creditBalance");
  const monthly = pickNumber(org, "tier.maxMonthlyCreditSpend");
  return {
    metric: { value: credits, unit: "credits", display: `${amount(credits, "credits")} (≈${amount(credits / 100, "USD")})` },
    note: monthly !== undefined ? `开发者 API，当前档位每月最多购买 ${amount(monthly, "credits")}` : "开发者 API",
  };
}
