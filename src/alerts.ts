import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CheckResult, Level } from "./types.js";

/** Per-check memory between runs (persisted so a restart does not re-alert). */
export interface CheckState {
  /** Level the channel was last told about ("ok" = nothing outstanding). */
  notified: Level;
  /** Current raw level and how many runs in a row it has held (debounce). */
  streakLevel?: Level;
  streak: number;
  /** Consecutive check failures (level "error"). */
  failures: number;
  lastAlertAt?: string;
  /** Set after an auth failure: the check is skipped until then. */
  suspendedUntil?: string;
}

export interface State {
  checks: Record<string, CheckState>;
  lastDailySummary?: string;
}

export type AlertType = "alert" | "remind" | "recover";

export interface AlertEvent {
  type: AlertType;
  result: CheckResult;
  /** Level that was outstanding before a recovery. */
  previous?: Level;
  failures?: number;
}

export interface EvaluateOptions {
  now: number;
  alertAfter: number;
  failuresBeforeAlert: number;
  remindMs: number;
  /** How long to pause a check whose credentials were rejected. */
  authBackoffMs: number;
}

const RANK: Record<string, number> = { ok: 0, warn: 1, crit: 2 };

export function initialState(): CheckState {
  return { notified: "ok", streak: 0, failures: 0 };
}

/**
 * Decide whether this result needs a message, and the next state.
 * - warn/crit: alert after `alertAfter` runs in a row, again at once if it gets worse, remind every `remindMs`.
 * - error: alert after `failuresBeforeAlert` consecutive failures (auth failures: at once, then pause).
 * - back to ok after anything was announced: one recovery message.
 * - "off" (disabled / not configured) never alerts and leaves the state alone.
 */
export function evaluate(prev: CheckState, result: CheckResult, opts: EvaluateOptions): { next: CheckState; event?: AlertEvent } {
  const level = result.level;
  if (level === "off") return { next: prev };
  const nowIso = new Date(opts.now).toISOString();
  const next: CheckState = { ...prev };
  const remindDue = !prev.lastAlertAt || opts.now - Date.parse(prev.lastAlertAt) >= opts.remindMs;

  next.streak = prev.streakLevel === level ? prev.streak + 1 : 1;
  next.streakLevel = level;

  if (level === "error") {
    next.failures = prev.failures + 1;
    if (result.authFailed && (!prev.suspendedUntil || Date.parse(prev.suspendedUntil) <= opts.now)) {
      next.suspendedUntil = new Date(opts.now + opts.authBackoffMs).toISOString();
    }
    const threshold = result.authFailed ? 1 : opts.failuresBeforeAlert;
    if (next.failures < threshold) return { next };
    if (prev.notified !== "error") {
      next.notified = "error";
      next.lastAlertAt = nowIso;
      return { next, event: { type: "alert", result, failures: next.failures } };
    }
    if (remindDue) {
      next.lastAlertAt = nowIso;
      return { next, event: { type: "remind", result, failures: next.failures } };
    }
    return { next };
  }

  next.failures = 0;
  next.suspendedUntil = undefined;

  if (level === "ok") {
    if (prev.notified !== "ok") {
      next.notified = "ok";
      next.lastAlertAt = undefined;
      return { next, event: { type: "recover", result, previous: prev.notified } };
    }
    return { next };
  }

  // warn / crit
  if (next.streak < opts.alertAfter) return { next };
  const outstanding = prev.notified === "warn" || prev.notified === "crit";
  if (!outstanding || RANK[level] > RANK[prev.notified]) {
    next.notified = level;
    next.lastAlertAt = nowIso;
    return { next, event: { type: "alert", result } };
  }
  if (RANK[level] < RANK[prev.notified]) {
    // crit → warn: quietly lower the bar so a relapse to crit alerts again.
    next.notified = level;
    return { next };
  }
  if (remindDue) {
    next.lastAlertAt = nowIso;
    return { next, event: { type: "remind", result } };
  }
  return { next };
}

export function loadState(file: string): State {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as State;
    return { checks: s.checks ?? {}, lastDailySummary: s.lastDailySummary };
  } catch {
    return { checks: {} };
  }
}

export function saveState(file: string, state: State): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}
