import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CHECKS } from "./checks/index.js";
import { ROOT } from "./env.js";
import type { Config } from "./types.js";

/** Load ops.config.json (or $OPS_CONFIG). Secrets stay in .env.local, referenced as ${VAR}. */
export function loadConfig(): Config {
  const file = resolve(ROOT, process.env.OPS_CONFIG ?? "ops.config.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
  const config: Config = {
    intervalMinutes: raw.intervalMinutes ?? 10,
    remindHours: raw.remindHours ?? 6,
    failuresBeforeAlert: raw.failuresBeforeAlert ?? 3,
    timezone: raw.timezone ?? "Asia/Shanghai",
    dailySummaryAt: raw.dailySummaryAt,
    services: raw.services ?? [],
  };

  const problems: string[] = [];
  const serviceIds = new Set<string>();
  for (const s of config.services) {
    if (!s.id || serviceIds.has(s.id)) problems.push(`服务 id 缺失或重复: ${s.id}`);
    serviceIds.add(s.id);
    const checkIds = new Set<string>();
    for (const c of s.checks ?? []) {
      if (!c.id || checkIds.has(c.id)) problems.push(`${s.id}: 检查 id 缺失或重复: ${c.id}`);
      checkIds.add(c.id);
      if (!CHECKS[c.kind]) problems.push(`${s.id}/${c.id}: 未知的 kind "${c.kind}"（可用：${Object.keys(CHECKS).join(", ")}）`);
      for (const t of [c.warn, c.crit]) {
        if (t !== undefined && typeof t !== "number" && !/^\d+(\.\d+)?%$/.test(String(t))) {
          problems.push(`${s.id}/${c.id}: 阈值 "${t}" 只能是数字或 "20%"`);
        }
      }
    }
  }
  if (problems.length) throw new Error(`配置错误 (${file}):\n  ${problems.join("\n  ")}`);
  return config;
}
