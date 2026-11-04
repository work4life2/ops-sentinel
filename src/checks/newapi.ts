import { setting } from "../env.js";
import { amount } from "../format.js";
import { fetchJson, pickNumber } from "../http.js";
import { AuthError, NotConfiguredError, type CheckConfig, type Probe } from "../types.js";

/**
 * New API relay (e.g. www.cun.ai).
 *
 * - Account balance (what actually runs out): `accessToken` + `userId` from the console
 *   (个人设置 → 系统访问令牌), read via GET /api/user/self with the New-Api-User header.
 * - Token quota: `apiKey` (the sk- key the service uses), via GET /api/usage/token/. Our keys are
 *   usually unlimited, in which case only the spend is shown.
 *
 * Quota units are converted to USD with the relay's quota_per_unit (500000 = $1 by default).
 */
export async function newapi(cfg: CheckConfig): Promise<Probe> {
  const base = setting(cfg, "baseUrl").replace(/\/+$/, "").replace(/\/v1$/, "");
  const accessToken = setting(cfg, "accessToken", true);
  const userId = setting(cfg, "userId", true);
  const apiKey = setting(cfg, "apiKey", true);
  if (!(accessToken && userId) && !apiKey) {
    throw new NotConfiguredError("缺 CUNAI_ACCESS_TOKEN + CUNAI_USER_ID（控制台 → 个人设置 → 系统访问令牌）");
  }

  const perUnit = await quotaPerUnit(base, cfg);
  const usd = (q: number) => q / perUnit;
  const notes: string[] = [];
  const warnings: string[] = [];
  let probe: Probe = {};

  if (apiKey) {
    const res = await fetchJson(`${base}/api/usage/token/`, { headers: { authorization: `Bearer ${apiKey}` } });
    if (res?.code === false || res?.success === false) throw new Error(`令牌查询失败: ${res.message ?? "unknown"}`);
    const d = res?.data ?? {};
    const used = usd(Number(d.total_used ?? 0));
    if (d.unlimited_quota) {
      notes.push(`key ${d.name ?? ""} 不限额，累计已用 ${amount(used, "USD")}`);
      probe = { headline: "key 不限额" };
    } else {
      const left = usd(Number(d.total_available ?? 0));
      const granted = usd(Number(d.total_granted ?? 0));
      notes.push(`key ${d.name ?? ""} 额度 ${amount(granted, "USD")}`);
      probe = { metric: { value: left, limit: granted || undefined, unit: "USD" } };
    }
  }

  if (accessToken && userId) {
    const res = await fetchJson(`${base}/api/user/self`, {
      headers: { authorization: `Bearer ${accessToken}`, "new-api-user": userId },
    });
    if (res?.success === false) {
      // New API answers auth problems with HTTP 200 + success:false.
      const msg = String(res.message ?? "unknown");
      if (/token|令牌|登录|权限|unauthor|未授权/i.test(msg)) throw new AuthError(`账户查询被拒绝: ${msg}`);
      throw new Error(`账户查询失败: ${msg}`);
    }
    const quota = pickNumber(res, "data.quota");
    if (quota === undefined) throw new Error("账户返回里没有 data.quota");
    const used = pickNumber(res, "data.used_quota") ?? 0;
    notes.unshift(`账户 ${res.data?.username ?? userId} 累计消费 ${amount(usd(used), "USD")}`);
    probe = { metric: { value: usd(quota), unit: "USD" } };
  }

  if (!(accessToken && userId) && !probe.metric) {
    warnings.push("cun.ai 没配 accessToken/userId：账户余额不在监控范围，用完不会告警");
  }
  return { ...probe, note: notes.join("；"), warnings };
}

const perUnitCache = new Map<string, number>();

async function quotaPerUnit(base: string, cfg: CheckConfig): Promise<number> {
  if (typeof cfg.quotaPerUnit === "number") return cfg.quotaPerUnit;
  const cached = perUnitCache.get(base);
  if (cached) return cached;
  let value = 500_000;
  try {
    const status = await fetchJson(`${base}/api/status`);
    value = pickNumber(status, "data.quota_per_unit") || value;
  } catch {
    // Older New API builds hide /api/status; the default is right for almost every deployment.
  }
  perUnitCache.set(base, value);
  return value;
}
