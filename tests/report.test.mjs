import assert from "node:assert/strict";
import { test } from "node:test";
import { settledTime } from "../dist/checks/holo.js";
import { periodStart } from "../dist/checks/mobula.js";
import { alertMessage, summaryMessage, summaryPlain } from "../dist/report.js";

const config = {
  timezone: "Asia/Shanghai",
  services: [
    { id: "svc", name: "服务甲", checks: [] },
    { id: "pay", name: "Runway", checks: [] },
  ],
};
const base = { serviceId: "svc", serviceName: "服务甲", warnings: [], ops: [], at: "", ms: 0 };
const results = [
  { ...base, checkId: "health", name: "服务在线", kind: "http-health", level: "ok", headline: "在线 12ms" },
  {
    ...base,
    checkId: "orders",
    name: "订单流水",
    kind: "holo-card-agent",
    level: "ok",
    headline: "进行中 0",
    ops: [{ label: "服务甲", inFlight: 0, awaiting: 2, settled1d: 1, settled7d: 9, revenue7d: 9, currency: "USDC", failed1d: 1 }],
    warnings: ["服务甲有 2 单交付超过 7 天仍未结算"],
  },
  {
    ...base,
    serviceId: "pay",
    serviceName: "Runway",
    checkId: "credits",
    name: "账户 credits",
    kind: "http-json",
    level: "warn",
    metric: { value: 400, unit: "credits" },
    headline: "400 credits",
    warnText: "500 credits",
    critText: "150 credits",
  },
  { ...base, serviceId: "pay", serviceName: "Runway", checkId: "dev", name: "开发者 API", kind: "runway", level: "off", headline: "未配置：缺少环境变量 RUNWAY_API_KEY" },
];

const EMOJI = /\p{Extended_Pictographic}/u;

test("summary: native tables, no emoji, abnormal cells bold", () => {
  const msg = summaryMessage(results, config, new Date("2026-11-04T04:00:00Z"));
  const types = msg.blocks.map((b) => b.type);
  assert.equal(types.filter((t) => t === "table").length, 2);
  const json = JSON.stringify(msg);
  assert.equal(EMOJI.test(json), false, "summary must not contain emoji");

  const [quota, ops] = msg.blocks.filter((b) => b.type === "table");
  for (const t of [quota, ops]) {
    assert.ok(t.column_settings.every((c) => c && typeof c === "object"), "Slack rejects null column_settings");
  }
  assert.equal(quota.rows.length, 2); // header + Runway (the off check is listed separately)
  const statusCell = quota.rows[1][2];
  assert.equal(statusCell.type, "rich_text"); // "警告" is bold
  assert.equal(statusCell.elements[0].elements[0].text, "警告");
  assert.equal(ops.rows[1][1].text, "在线");
  assert.equal(ops.rows[1][7].type, "rich_text"); // 24h failures > 0 flagged

  const cells = msg.blocks.filter((b) => b.type === "table").flatMap((t) => t.rows.flat());
  const chars = cells.reduce((n, c) => n + (c.text ?? c.elements[0].elements[0].text).length, 0);
  assert.ok(chars < 10_000);

  assert.match(json, /需要关注/);
  assert.match(json, /低于警告线 500 credits/);
  assert.match(json, /未配置：Runway 开发者 API/);
});

test("plain summary renders aligned tables", () => {
  const text = summaryPlain(results, config, new Date("2026-11-04T04:00:00Z"));
  assert.match(text, /额度 \/ 余额\n服务\s+项目\s+状态/);
  assert.match(text, /\*警告/);
  assert.equal(EMOJI.test(text), false);
});

test("alerts have no emoji and say which line was crossed", () => {
  const msg = alertMessage({ type: "alert", result: results[2] });
  assert.equal(EMOJI.test(msg.text), false);
  assert.match(msg.text, /^\*\[警告\]\* Runway \/ 账户 credits/);
  assert.match(msg.text, /当前 400 credits，低于警告线 500 credits/);
  const rec = alertMessage({ type: "recover", result: { ...results[2], level: "ok" }, previous: "warn" });
  assert.match(rec.text, /^\*\[已恢复\]\*/);
});

test("mobula billing period", () => {
  assert.equal(periodStart(new Date("2026-11-04T00:00:00Z"), 20).toISOString(), "2026-10-20T00:00:00.000Z");
  assert.equal(periodStart(new Date("2026-11-25T00:00:00Z"), 20).toISOString(), "2026-11-20T00:00:00.000Z");
  assert.equal(periodStart(new Date("2026-01-05T00:00:00Z"), 20).toISOString(), "2025-12-20T00:00:00.000Z");
  assert.equal(periodStart(new Date("2026-11-04T00:00:00Z"), 1).toISOString(), "2026-11-01T00:00:00.000Z");
});

test("holo settlement time ignores prune bumps", () => {
  const t = "2026-11-04T00:00:00.000Z";
  assert.equal(settledTime({ updatedAt: t, settledAt: "2026-10-16T06:02:32.833Z" }), Date.parse("2026-10-16T06:02:32.833Z"));
  assert.equal(settledTime({ updatedAt: t, prunedAt: t }), undefined); // updatedAt is the prune, not the payout
  assert.equal(settledTime({ updatedAt: t, prunedAt: "2026-10-01T00:00:00.000Z" }), Date.parse(t));
  assert.equal(settledTime({ updatedAt: t }), Date.parse(t));
});
