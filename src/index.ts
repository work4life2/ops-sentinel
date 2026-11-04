#!/usr/bin/env node
import { resolve } from "node:path";
import { evaluate, initialState, loadState, saveState, type AlertEvent, type CheckState } from "./alerts.js";
import { DEFAULT_ALERT_AFTER } from "./checks/index.js";
import { loadConfig } from "./config.js";
import { DATA_DIR, env, loadEnvFiles } from "./env.js";
import { localDayAndTime } from "./format.js";
import { alertMessage, summaryMessage, summaryPlain, toPlain, type SlackMessage } from "./report.js";
import { checkKey, runAll } from "./runner.js";
import type { Bot } from "./slack.js";
import type { CheckResult, Config } from "./types.js";

const AUTH_BACKOFF_MS = 6 * 3600_000;
/** /ops answers from the last scheduled run if it is this fresh. */
const SUMMARY_CACHE_MS = 60_000;

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function usage(): never {
  console.log(`ops-sentinel: 配额告警 + 服务状态汇总（Slack）

  node dist/index.js check [服务id] [--json]   立即跑一遍检查并在终端打印（不发 Slack、不改告警状态）
  node dist/index.js serve [--dry-run]         定时检查 + 告警 + Slack 命令；--dry-run 时告警只打印到终端
  node dist/index.js test-alert                往 SLACK_CHANNEL_ID 发一条测试消息

配置：ops.config.json（检查项）+ .env.local（密钥）。见 README.md。`);
  process.exit(1);
}

async function check(args: string[]): Promise<void> {
  const config = loadConfig();
  const only = args.find((a) => !a.startsWith("--"));
  if (only && !config.services.some((s) => s.id === only)) throw new Error(`没有服务 ${only}`);
  const results = await runAll(config, { only });
  if (args.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log(summaryPlain(results, config));
}

async function serve(args: string[]): Promise<void> {
  const config = loadConfig();
  const dryRun = args.includes("--dry-run");
  const stateFile = resolve(DATA_DIR, "state.json");
  const state = loadState(stateFile);
  // A restart is how the operator says "credentials fixed": lift every auth pause.
  for (const s of Object.values(state.checks)) s.suspendedUntil = undefined;
  const mention = env("SLACK_ALERT_MENTION");
  const alertAfterOf = new Map<string, number>();
  for (const s of config.services) {
    for (const c of s.checks) alertAfterOf.set(checkKey(s.id, c.id), c.alertAfter ?? DEFAULT_ALERT_AFTER[c.kind] ?? 1);
  }

  let cache: { at: number; results: CheckResult[] } | undefined;
  const suspended = () => Object.fromEntries(Object.entries(state.checks).map(([k, v]) => [k, v.suspendedUntil]));

  async function summarize(only?: string): Promise<CheckResult[]> {
    if (cache && Date.now() - cache.at < SUMMARY_CACHE_MS) {
      return only ? cache.results.filter((r) => r.serviceId === only) : cache.results;
    }
    const results = await runAll(config, { only, suspended: suspended() });
    if (!only) cache = { at: Date.now(), results };
    return results;
  }

  let bot: Bot | undefined;
  if (!dryRun) {
    // Loaded lazily: importing Bolt swaps Node's global fetch dispatcher, which `check` should not pay for.
    const { createBot } = await import("./slack.js");
    bot = createBot({ config, summarize, log });
    await bot.start();
  } else {
    log("[serve] dry run: alerts go to stdout, no Slack connection");
  }

  async function deliver(message: SlackMessage): Promise<boolean> {
    if (!bot) {
      console.log(`----- ALERT -----\n${toPlain(message.text)}\n-----------------`);
      return true;
    }
    try {
      await bot.post(message);
      return true;
    } catch (err) {
      log(`[slack] post failed: ${(err as Error).message}`);
      return false;
    }
  }

  let running = false;
  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const results = await runAll(config, { suspended: suspended() });
      cache = { at: Date.now(), results };

      const pending: { key: string; prev: CheckState; event: AlertEvent }[] = [];
      for (const r of results) {
        const key = checkKey(r.serviceId, r.checkId);
        const prev = state.checks[key] ?? initialState();
        const { next, event } = evaluate(prev, r, {
          now,
          alertAfter: alertAfterOf.get(key) ?? 1,
          failuresBeforeAlert: config.failuresBeforeAlert,
          remindMs: config.remindHours * 3600_000,
          authBackoffMs: AUTH_BACKOFF_MS,
        });
        state.checks[key] = next;
        if (event) pending.push({ key, prev, event });
      }
      for (const { key, prev, event } of pending) {
        // Not delivered → roll this check back so the next run tries again.
        if (!(await deliver(alertMessage(event, mention)))) state.checks[key] = prev;
      }

      if (config.dailySummaryAt) {
        const { day, time } = localDayAndTime(new Date(now), config.timezone);
        if (time >= config.dailySummaryAt && state.lastDailySummary !== day) {
          if (await deliver(summaryMessage(results, config, new Date(now), "每日汇总"))) state.lastDailySummary = day;
        }
      }
      saveState(stateFile, state);

      const tally = results.reduce<Record<string, number>>((t, r) => ({ ...t, [r.level]: (t[r.level] ?? 0) + 1 }), {});
      log(`[tick] ${results.length} checks ${JSON.stringify(tally)}, ${pending.length} alert(s)`);
    } catch (err) {
      log(`[tick] failed: ${(err as Error).stack ?? err}`);
    } finally {
      running = false;
    }
  }

  await tick();
  const timer = setInterval(tick, config.intervalMinutes * 60_000);
  log(`[serve] checking every ${config.intervalMinutes} min`);

  const shutdown = async (signal: string) => {
    log(`[serve] ${signal}, stopping`);
    clearInterval(timer);
    saveState(stateFile, state);
    await bot?.stop().catch(() => undefined);
    // Exit only after stdout drains, or the last lines never reach journald.
    process.stdout.write("", () => process.exit(0));
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

async function testAlert(): Promise<void> {
  const config: Config = loadConfig();
  const { createBot } = await import("./slack.js");
  const bot = createBot({ config, summarize: async () => [], log });
  await bot.post({
    text: "ops-sentinel 测试消息：机器人能往这个频道发消息了。",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "*ops-sentinel 测试消息*：机器人能往这个频道发消息了。" } }],
  });
  log("[test-alert] sent");
}

async function main(): Promise<void> {
  loadEnvFiles();
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "check") return check(args);
  if (cmd === "serve") return serve(args);
  if (cmd === "test-alert") return testAlert();
  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
