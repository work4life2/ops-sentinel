import { setting } from "../env.js";
import { amount } from "../format.js";
import { fetchJson } from "../http.js";
import type { CheckConfig, OpsRow, Probe } from "../types.js";

interface MontageJob {
  id: string;
  kind: "order" | "subtask";
  orderId?: string;
  status: string;
  error?: string;
  updatedAt: string;
  settledAt?: string;
  spendUsd?: number;
}

const ROLES: Record<string, string> = {
  montage: "Montage",
  renderfarm: "RenderFarm",
  beatsmith: "Beatsmith",
  sketchboard: "Sketchboard",
};
const IN_FLIGHT = new Set(["queued", "accepting", "working", "built", "delivering"]);
const DAY = 86_400_000;

/**
 * Montage-Studio (four agents in one service, 127.0.0.1:8795, no auth): one row per agent from
 * GET /api/jobs (newest 100 per role) and the live `busy` list from GET /health. Montage jobs sit in
 * `working` for hours while the crew delivers, so `stuckHours` defaults to 6. Jobs carry no price,
 * so revenue is left blank; `spendUsd` (Runway + images + gas) is shown as 7-day cost instead.
 */
export async function montageStudio(cfg: CheckConfig): Promise<Probe> {
  const base = setting(cfg, "baseUrl").replace(/\/+$/, "");
  const [health, byRole] = await Promise.all([
    fetchJson(`${base}/health`),
    fetchJson<Record<string, MontageJob[]>>(`${base}/api/jobs`),
  ]);
  const now = Date.now();
  const age = (j: MontageJob) => now - Date.parse(j.updatedAt);
  const settledAge = (j: MontageJob) => now - Date.parse(j.settledAt ?? j.updatedAt);
  const stuckMs = Number(cfg.stuckHours ?? 6) * 3600_000;
  const ops: OpsRow[] = [];
  const warnings: string[] = [];

  for (const [role, label] of Object.entries(ROLES)) {
    const served = health?.agents?.[role];
    // Local test jobs ("local:") and sub-tasks accepted before indexing ("pending:") are not real orders.
    const jobs = (byRole[role] ?? []).filter((j) => !/^(local|pending):/.test(j.orderId ?? ""));
    const inFlight = jobs.filter((j) => IN_FLIGHT.has(j.status));
    const waitingBuyer = jobs.filter((j) => j.status === "awaiting_input");
    const failed1d = jobs.filter((j) => j.status === "failed" && age(j) < DAY);
    const cost7d = jobs.filter((j) => age(j) < 7 * DAY).reduce((s, j) => s + (j.spendUsd ?? 0), 0);

    const stuck = inFlight.filter((j) => age(j) > stuckMs);
    if (stuck.length) warnings.push(`${label} 有 ${stuck.length} 单在 ${stuck[0].status} 超过 ${cfg.stuckHours ?? 6} 小时：${stuck.map((j) => j.id).join("、")}`);
    if (failed1d.length) warnings.push(`${label} 24 小时内失败 ${failed1d.length} 单，最近：${(failed1d[0].error ?? "?").slice(0, 120)}`);

    const notes = [
      served ? (served.busy?.length ? `运行中 ${served.busy.length}` : undefined) : "未在 SERVE_ROLES 中",
      waitingBuyer.length ? `等买家回复 ${waitingBuyer.length}` : undefined,
      cost7d > 0 ? `7天成本 ${amount(cost7d, "USD")}` : undefined,
    ].filter(Boolean);
    ops.push({
      label,
      inFlight: inFlight.length,
      awaiting: jobs.filter((j) => j.status === "delivered").length,
      settled1d: jobs.filter((j) => j.status === "settled" && settledAge(j) < DAY).length,
      settled7d: jobs.filter((j) => j.status === "settled" && settledAge(j) < 7 * DAY).length,
      failed1d: failed1d.length,
      note: notes.join("，") || undefined,
    });
  }

  const level = warnings.some((w) => w.includes("超过")) ? "warn" : "ok";
  const total = ops.reduce((s, r) => s + (r.inFlight ?? 0), 0);
  return { level, headline: level === "warn" ? warnings[0] : `进行中 ${total}`, ops, warnings };
}
