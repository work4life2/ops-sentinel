import type { Level } from "./types.js";

export const LEVEL_LABEL: Record<Level, string> = {
  ok: "正常",
  warn: "警告",
  crit: "严重",
  error: "检查失败",
  off: "未配置",
};

/** Format an amount in its unit: USD as $1,234.56, chain coins with enough decimals to be useful. */
export function amount(value: number, unit: string): string {
  if (unit === "USD") {
    const digits = Math.abs(value) < 1000 ? 2 : 0;
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }
  if (Number.isInteger(value) && Math.abs(value) >= 1) return `${value.toLocaleString("en-US")} ${unit}`;
  const digits = Math.abs(value) >= 1 ? 3 : Math.abs(value) >= 0.01 ? 4 : 6;
  return `${value.toFixed(digits).replace(/\.?0+$/, "")} ${unit}`;
}

/** "3小时前" style age for an ISO timestamp. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "?";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}秒前`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}分钟前`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}小时前`;
  return `${Math.round(h / 24)}天前`;
}

export function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}天${h}小时`;
  if (h) return `${h}小时${m}分`;
  return `${m}分`;
}

/** Local wall-clock time in the configured timezone, e.g. "11-03 12:30". */
export function clock(date: Date, timezone: string, withDate = true): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hm = `${get("hour")}:${get("minute")}`;
  return withDate ? `${get("month")}-${get("day")} ${hm}` : hm;
}

/** YYYY-MM-DD and HH:MM in the configured timezone (for the daily digest). */
export function localDayAndTime(date: Date, timezone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}
