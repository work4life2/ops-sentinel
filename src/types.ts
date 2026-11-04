/** Severity of one check, ordered: ok < warn < crit. `error` means the check itself could not run. */
export type Level = "ok" | "warn" | "crit" | "error" | "off";

export const LEVEL_RANK: Record<Level, number> = { off: -1, ok: 0, warn: 1, crit: 2, error: 1 };

/** A number the thresholds are compared against (remaining balance, credits left, ...). */
export interface Metric {
  value: number;
  /** Total budget, when known: enables "20%" thresholds and "x / y" display. */
  limit?: number;
  unit: string;
  /** Pre-formatted value for display; defaults to `value unit`. */
  display?: string;
}

/** One row of the "服务状态" table: an order pipeline (a service, or one agent of a multi-agent service). */
export interface OpsRow {
  label: string;
  inFlight?: number;
  awaiting?: number;
  settled1d?: number;
  settled7d?: number;
  revenue7d?: number;
  currency?: string;
  failed1d?: number;
  note?: string;
}

/** What a check implementation returns. Thresholds are applied afterwards by the runner. */
export interface Probe {
  /** Quota checks set this; the runner derives the level from it and the configured thresholds. */
  metric?: Metric;
  /** Health/status checks decide their own level (e.g. a dead endpoint is crit). */
  level?: Level;
  /** Status text for checks without a metric (e.g. "在线 187ms"). */
  headline?: string;
  /** Short remark for the table's 说明 column. */
  note?: string;
  /** Things to flag in "需要关注" even when the level is ok (stale deliveries, overage...). */
  warnings?: string[];
  /** Rows for the 服务状态 table. */
  ops?: OpsRow[];
}

/** Threshold: a plain number is absolute (in the metric's unit), "20%" is relative to `limit`. */
export type Threshold = number | `${number}%`;

export interface CheckConfig {
  id: string;
  kind: string;
  name: string;
  enabled?: boolean;
  warn?: Threshold;
  crit?: Threshold;
  /** Consecutive warn/crit results before alerting (default 1; health checks default 2). */
  alertAfter?: number;
  /** Kind-specific settings; strings may contain ${ENV_VAR}. */
  [key: string]: unknown;
}

export interface ServiceConfig {
  id: string;
  name: string;
  enabled?: boolean;
  checks: CheckConfig[];
}

export interface Config {
  intervalMinutes: number;
  remindHours: number;
  failuresBeforeAlert: number;
  timezone: string;
  /** Post the full summary every day at this local time ("09:00"); doubles as a heartbeat. */
  dailySummaryAt?: string;
  services: ServiceConfig[];
}

export interface CheckResult {
  serviceId: string;
  serviceName: string;
  checkId: string;
  name: string;
  kind: string;
  level: Level;
  metric?: Metric;
  headline: string;
  note?: string;
  warnings: string[];
  ops: OpsRow[];
  error?: string;
  /** Credentials were rejected: alert at once and pause this check (repeat 401s get the IP banned). */
  authFailed?: boolean;
  /** Thresholds formatted in the metric's unit, for display. */
  warnText?: string;
  critText?: string;
  at: string;
  ms: number;
}

/** Thrown by checks when the credentials are rejected: the runner backs off instead of retrying (fail2ban). */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Thrown when a required setting (env var, address) is missing: shown as "未配置", never alerted. */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}
