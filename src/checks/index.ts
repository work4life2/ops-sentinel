import type { CheckConfig, Probe } from "../types.js";
import { evmBalance } from "./evm.js";
import { httpHealth } from "./health.js";
import { holoCardAgent } from "./holo.js";
import { httpJson } from "./httpJson.js";
import { jevFcBuddy } from "./jev.js";
import { mobula } from "./mobula.js";
import { montageStudio } from "./montage.js";
import { newapi } from "./newapi.js";
import { openrouter } from "./openrouter.js";
import { runway } from "./runway.js";

export type CheckFn = (cfg: CheckConfig) => Promise<Probe>;

/** Check kinds usable in ops.config.json. Add a provider = add a file here (or use "http-json"). */
export const CHECKS: Record<string, CheckFn> = {
  newapi,
  openrouter,
  runway,
  "evm-balance": evmBalance,
  "http-json": httpJson,
  "http-health": httpHealth,
  "holo-card-agent": holoCardAgent,
  "jev-fc-buddy": jevFcBuddy,
  "montage-studio": montageStudio,
  mobula,
};

/** Kinds that only describe service health / order flow: they feed the 服务运行 table, not the quota table. */
export const STATUS_KINDS = new Set(["http-health", "holo-card-agent", "montage-studio"]);

/** Kinds whose level comes from liveness: give them a second chance before alerting. */
export const DEFAULT_ALERT_AFTER: Record<string, number> = { "http-health": 2 };
