import { setting } from "../env.js";
import { amount } from "../format.js";
import { fetchJson } from "../http.js";
import type { CheckConfig, Probe } from "../types.js";

interface JevJob {
  orderId: string;
  status: string;
  price?: string;
  currency?: string;
  updatedAt: string;
}

const DAY = 86_400_000;

/**
 * jev-fc-buddy, from GET /api/admin/overview and /api/admin/orders (Bearer ADMIN_TOKEN). The overview
 * already reads the OpenRouter key (buyer chat + Jev are billed to it), so its `creditsLeft` is this
 * check's metric. Fields are absent rather than null when the service could not fetch them.
 */
export async function jevFcBuddy(cfg: CheckConfig): Promise<Probe> {
  const base = setting(cfg, "baseUrl").replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${setting(cfg, "adminToken")}` };
  const [o, list] = await Promise.all([
    fetchJson(`${base}/api/admin/overview`, { headers, timeoutMs: 20_000 }),
    fetchJson<{ orders?: JevJob[] } | JevJob[]>(`${base}/api/admin/orders`, { headers, timeoutMs: 20_000 }),
  ]);
  const jobs: JevJob[] = Array.isArray(list) ? list : (list.orders ?? []);

  const spend = o.spend ?? {};
  const coins = o.coins ?? {};
  const sessions = o.sessions ?? {};
  const currency = String(o.orders?.currency ?? o.settings?.currency ?? "USDC");

  const now = Date.now();
  const within = (j: JevJob, ms: number) => now - Date.parse(j.updatedAt) < ms;
  const paid = (j: JevJob) => j.status === "delivered" || j.status === "settled";
  const settled7d = jobs.filter((j) => j.status === "settled" && within(j, 7 * DAY));
  const warnings: string[] = [];
  const disputed = jobs.filter((j) => j.status === "disputed");
  if (disputed.length) warnings.push(`FC 游戏搭子有 ${disputed.length} 单在争议中：${disputed.map((j) => j.orderId).join("、")}`);
  if (o.hosting && !o.hosting.enabled) warnings.push("FC 游戏搭子的 Termix 托管没开，不会接单");

  const ops = [{
    label: String(cfg.label ?? "FC 游戏搭子"),
    inFlight: jobs.filter((j) => ["accepting", "minting", "delivering"].includes(j.status)).length,
    awaiting: jobs.filter((j) => j.status === "delivered").length,
    settled1d: jobs.filter((j) => j.status === "settled" && within(j, DAY)).length,
    settled7d: settled7d.length,
    revenue7d: jobs.filter((j) => paid(j) && within(j, 7 * DAY)).reduce((sum, j) => sum + (Number(j.price) || 0), 0),
    currency,
    // Failures from the 10-26 bot flood are old; only fresh ones matter here.
    failed1d: jobs.filter((j) => j.status === "failed" && within(j, DAY)).length,
    note: `在线 ${sessions.live ?? "?"} 局，今日用币 ${coins.usedToday ?? "?"}，累计收入 ${amount(Number(o.orders?.revenue ?? 0), currency)}`,
  }];

  const usage = spend.today !== undefined
    ? `今天 ${amount(spend.today, "USD")}，本月 ${amount(spend.month ?? 0, "USD")}`
    : undefined;
  if (typeof spend.creditsLeft === "number") {
    return { metric: { value: spend.creditsLeft, unit: "USD" }, note: usage, ops, warnings };
  }
  // The service could not read its relay balance: surface it as a check failure, keep the rest.
  return { level: "error", headline: `读不到 OpenRouter 余额：${spend.error ?? "creditsLeft 缺失"}`, ops, warnings };
}
