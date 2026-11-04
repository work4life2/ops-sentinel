import { setting } from "../env.js";
import { ago, duration } from "../format.js";
import { fetchJson, headersFrom } from "../http.js";
import type { CheckConfig, Probe } from "../types.js";

interface HoloJob {
  id: string;
  orderId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  prunedAt?: string;
  settledAt?: string;
}

/**
 * When a job settled. holo records settledAt since e00e34a; for older jobs updatedAt is the best guess,
 * except when it is the prune time (prune bumps updatedAt), which would make an old settlement look new.
 */
export function settledTime(j: { updatedAt: string; prunedAt?: string; settledAt?: string }): number | undefined {
  if (j.settledAt) return Date.parse(j.settledAt);
  if (j.prunedAt && j.prunedAt === j.updatedAt) return undefined;
  return Date.parse(j.updatedAt);
}

const IN_FLIGHT = new Set(["accepting", "building", "built", "delivering"]);
const DAY = 86_400_000;

/**
 * holo-card-agent (3dcardagent) order pipeline, from its dashboard API
 * (`baseUrl` = http://<host>/<DASHBOARD_PATH>, nginx basic auth; or http://127.0.0.1:8787/<path> on the box).
 * Warns when a build has been in flight longer than `stuckMinutes` (default 60).
 */
export async function holoCardAgent(cfg: CheckConfig): Promise<Probe> {
  const base = setting(cfg, "baseUrl").replace(/\/+$/, "");
  const headers = headersFrom(cfg);
  const [status, jobs] = await Promise.all([
    fetchJson(`${base}/api/status`, { headers }),
    fetchJson<HoloJob[]>(`${base}/api/jobs`, { headers }),
  ]);
  const now = Date.now();
  const within = (j: HoloJob, ms: number) => now - Date.parse(j.updatedAt) < ms;
  const orders = jobs.filter((j) => !j.orderId?.startsWith("local:"));

  const inFlight = orders.filter((j) => IN_FLIGHT.has(j.status));
  const queued = orders.filter((j) => j.status === "queued" && within(j, DAY));
  const awaiting = orders.filter((j) => j.status === "delivered");
  const settledWithin = (j: HoloJob, ms: number) => {
    const t = j.status === "settled" ? settledTime(j) : undefined;
    return t !== undefined && now - t < ms;
  };
  const settled1d = orders.filter((j) => settledWithin(j, DAY));
  const settled7d = orders.filter((j) => settledWithin(j, 7 * DAY));
  const failed1d = orders.filter((j) => j.status === "failed" && within(j, DAY));

  const price = Number(status?.service?.price ?? 0);
  const currency = String(status?.service?.currency ?? "USDC");
  const stuckMs = Number(cfg.stuckMinutes ?? 60) * 60_000;
  const stuck = inFlight.filter((j) => now - Date.parse(j.updatedAt) > stuckMs);

  // Claims run automatically once the challenge window ends; deliveries this old are worth a look.
  const staleDays = Number(cfg.staleDeliveryDays ?? 7);
  const stale = awaiting.filter((j) => now - Date.parse(j.updatedAt) > staleDays * DAY);
  const warnings: string[] = [];
  if (stale.length) warnings.push(`3D 卡牌有 ${stale.length} 单交付超过 ${staleDays} 天仍未结算：${stale.map((j) => j.orderId).join("、")}`);
  if (failed1d.length) {
    warnings.push(`3D 卡牌 24 小时内失败 ${failed1d.length} 单，最近：${truncate(failed1d.sort(byUpdatedDesc)[0].error ?? "?", 120)}`);
  }
  if (status?.walletConfigured === false) warnings.push("3D 卡牌没配热钱包，接不了单");

  const notes: string[] = [];
  if (queued.length) notes.push(`24h 内排队 ${queued.length}`);
  if (inFlight.length) notes.push(inFlight.map((j) => `${j.status} ${ago(j.updatedAt, now)}`).join("，"));
  if (typeof status?.uptimeSeconds === "number") notes.push(`进程运行 ${duration(status.uptimeSeconds)}`);

  const ops = [{
    label: String(cfg.label ?? "3D 卡牌"),
    inFlight: inFlight.length,
    awaiting: awaiting.length,
    settled1d: settled1d.length,
    settled7d: settled7d.length,
    revenue7d: price * settled7d.length,
    currency,
    failed1d: failed1d.length,
    note: notes.join("；") || undefined,
  }];
  const headline = `进行中 ${inFlight.length}，待结算 ${awaiting.length}`;
  if (stuck.length) {
    return { level: "warn", headline: `${stuck.length} 单卡在 ${stuck[0].status} 超过 ${cfg.stuckMinutes ?? 60} 分钟`, ops, warnings };
  }
  if (status?.walletConfigured === false) return { level: "warn", headline: "没配热钱包", ops, warnings };
  return { level: "ok", headline, ops, warnings };
}

function oldest(jobs: HoloJob[]): string {
  return jobs.map((j) => j.updatedAt).sort()[0];
}

function byUpdatedDesc(a: HoloJob, b: HoloJob): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ");
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}
