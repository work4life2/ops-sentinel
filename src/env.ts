import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NotConfiguredError } from "./types.js";

export const ROOT = process.cwd();
export const DATA_DIR = resolve(ROOT, process.env.DATA_DIR ?? "data");

/** Load .env then .env.local (later files do not override variables already set in the environment). */
export function loadEnvFiles(): void {
  for (const name of [".env.local", ".env"]) {
    const file = resolve(ROOT, name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

/** Value of an env var, or undefined when unset/blank. */
export function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/**
 * Replace ${VAR} in a config string with the env value. A missing variable makes the whole check
 * "not configured" rather than sending a request with an empty secret.
 */
export function interpolate(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const v = env(name);
    if (v === undefined) throw new NotConfiguredError(`缺少环境变量 ${name}`);
    return v;
  });
}

/** Read a string setting from a check config, interpolating env vars. */
export function setting(cfg: Record<string, unknown>, key: string): string;
export function setting(cfg: Record<string, unknown>, key: string, optional: true): string | undefined;
export function setting(cfg: Record<string, unknown>, key: string, optional = false): string | undefined {
  const raw = cfg[key];
  if (raw === undefined || raw === null || raw === "") {
    if (optional) return undefined;
    throw new NotConfiguredError(`缺少配置项 ${key}`);
  }
  if (typeof raw !== "string") return String(raw);
  try {
    return interpolate(raw);
  } catch (err) {
    if (optional && err instanceof NotConfiguredError) return undefined;
    throw err;
  }
}
