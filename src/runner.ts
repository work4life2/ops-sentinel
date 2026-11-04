import { CHECKS, type CheckFn } from "./checks/index.js";
import { amount, clock } from "./format.js";
import { AuthError, NotConfiguredError, type CheckConfig, type CheckResult, type Config, type Level, type Metric, type ServiceConfig, type Threshold } from "./types.js";

/** Resolve a threshold to an absolute number; "%" thresholds need a known limit. */
export function resolveThreshold(t: Threshold | undefined, limit: number | undefined): number | undefined {
  if (t === undefined) return undefined;
  if (typeof t === "number") return t;
  const pct = Number(t.slice(0, -1));
  if (limit === undefined || !Number.isFinite(pct)) return undefined;
  return (limit * pct) / 100;
}

/** Level of a metric: below crit → crit, below warn → warn, else ok. */
export function levelFor(metric: Metric, warn?: Threshold, crit?: Threshold): Level {
  const c = resolveThreshold(crit, metric.limit);
  const w = resolveThreshold(warn, metric.limit);
  if (c !== undefined && metric.value < c) return "crit";
  if (w !== undefined && metric.value < w) return "warn";
  return "ok";
}

function fmtThreshold(t: Threshold | undefined, metric: Metric): string | undefined {
  if (t === undefined) return undefined;
  if (typeof t === "number") return amount(t, metric.unit);
  const abs = resolveThreshold(t, metric.limit);
  return abs === undefined ? t : `${amount(abs, metric.unit)} (${t})`;
}

/** Last result per check, reused while younger than the check's minIntervalMinutes (paid endpoints). */
const lastResults = new Map<string, CheckResult>();

export function checkKey(serviceId: string, checkId: string): string {
  return `${serviceId}/${checkId}`;
}

export async function runCheck(
  service: ServiceConfig,
  check: CheckConfig,
  opts: { suspendedUntil?: string; timezone: string },
): Promise<CheckResult> {
  const started = Date.now();
  const base = {
    serviceId: service.id,
    serviceName: service.name,
    checkId: check.id,
    name: check.name,
    kind: check.kind,
    warnings: [] as string[],
    ops: [],
  };
  const done = (r: Partial<CheckResult> & { level: Level; headline: string }): CheckResult => ({
    ...base,
    ...r,
    warnings: r.warnings ?? [],
    ops: r.ops ?? [],
    at: new Date().toISOString(),
    ms: Date.now() - started,
  });

  if (check.enabled === false || service.enabled === false) return done({ level: "off", headline: "已停用" });
  if (opts.suspendedUntil && Date.parse(opts.suspendedUntil) > Date.now()) {
    return done({
      level: "error",
      authFailed: true,
      headline: `凭据被拒绝，暂停检查到 ${clock(new Date(opts.suspendedUntil), opts.timezone)}（修好后重启生效）`,
    });
  }
  const fn = CHECKS[check.kind];
  if (!fn) return done({ level: "error", headline: `未知的检查类型 ${check.kind}` });

  const key = checkKey(service.id, check.id);
  const minMs = Number(check.minIntervalMinutes ?? 0) * 60_000;
  const cached = lastResults.get(key);
  if (minMs > 0 && cached && cached.level !== "error" && Date.now() - Date.parse(cached.at) < minMs) return cached;
  const result = await runProbe(check, fn, done);
  lastResults.set(key, result);
  return result;
}

async function runProbe(
  check: CheckConfig,
  fn: CheckFn,
  done: (r: Partial<CheckResult> & { level: Level; headline: string }) => CheckResult,
): Promise<CheckResult> {
  try {
    const probe = await fn(check);
    const metric = probe.metric;
    const level = probe.level ?? (metric ? levelFor(metric, check.warn, check.crit) : "ok");
    const metricText = metric ? (metric.display ?? amount(metric.value, metric.unit) + (metric.limit ? ` / ${amount(metric.limit, metric.unit)}` : "")) : undefined;
    return done({
      level,
      metric,
      headline: metricText ?? probe.headline ?? "正常",
      note: metric && probe.headline ? [probe.headline, probe.note].filter(Boolean).join("；") : probe.note,
      warnings: probe.warnings,
      ops: probe.ops,
      warnText: metric ? fmtThreshold(check.warn, metric) : undefined,
      critText: metric ? fmtThreshold(check.crit, metric) : undefined,
    });
  } catch (err) {
    const e = err as Error;
    if (err instanceof NotConfiguredError) return done({ level: "off", headline: `未配置：${e.message}` });
    const message = e.name === "TimeoutError" ? "请求超时" : e.message;
    return done({ level: "error", headline: message, error: message, authFailed: err instanceof AuthError });
  }
}

/** Run every check (optionally one service) concurrently. */
export async function runAll(
  config: Config,
  opts: { only?: string; suspended?: Record<string, string | undefined> } = {},
): Promise<CheckResult[]> {
  const jobs: Promise<CheckResult>[] = [];
  for (const service of config.services) {
    if (opts.only && service.id !== opts.only) continue;
    for (const check of service.checks) {
      jobs.push(
        runCheck(service, check, {
          suspendedUntil: opts.suspended?.[checkKey(service.id, check.id)],
          timezone: config.timezone,
        }),
      );
    }
  }
  return Promise.all(jobs);
}
