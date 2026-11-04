import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, initialState } from "../dist/alerts.js";
import { parseCommand } from "../dist/commands.js";
import { CHECKS } from "../dist/checks/index.js";
import { levelFor, resolveThreshold, runCheck } from "../dist/runner.js";

const HOUR = 3600_000;
const opts = (now, extra = {}) => ({ now, alertAfter: 1, failuresBeforeAlert: 3, remindMs: 6 * HOUR, authBackoffMs: 6 * HOUR, ...extra });
const result = (level, extra = {}) => ({
  serviceId: "svc",
  serviceName: "Svc",
  checkId: "c",
  name: "C",
  kind: "x",
  level,
  headline: "h",
  details: [],
  at: "",
  ms: 0,
  ...extra,
});

/** Feed a sequence of levels, one run per hour; return the event types. */
function run(levels, extra) {
  let state = initialState();
  const events = [];
  levels.forEach((l, i) => {
    const r = typeof l === "string" ? result(l) : l;
    const { next, event } = evaluate(state, r, opts(i * HOUR, extra));
    state = next;
    events.push(event ? `${event.type}:${r.level}` : "-");
  });
  return { events, state };
}

test("thresholds: absolute and percent", () => {
  assert.equal(resolveThreshold(5, undefined), 5);
  assert.equal(resolveThreshold("20%", 50), 10);
  assert.equal(resolveThreshold("20%", undefined), undefined);
  assert.equal(levelFor({ value: 4, unit: "USD" }, 10, 3), "warn");
  assert.equal(levelFor({ value: 2, unit: "USD" }, 10, 3), "crit");
  assert.equal(levelFor({ value: 10, unit: "USD" }, 10, 3), "ok");
  assert.equal(levelFor({ value: 5, limit: 100, unit: "c" }, "20%", "5%"), "warn");
  assert.equal(levelFor({ value: 4, limit: 100, unit: "c" }, "20%", "5%"), "crit");
});

test("warn alerts once, escalates to crit, reminds after remindHours, recovers once", () => {
  const { events } = run(["ok", "warn", "warn", "crit", "crit", "crit", "crit", "crit", "crit", "crit", "crit", "ok", "ok"]);
  assert.deepEqual(events, [
    "-",
    "alert:warn",
    "-",
    "alert:crit", // worse → immediately
    "-", "-", "-", "-", "-",
    "remind:crit", // 6h after the crit alert
    "-",
    "recover:ok",
    "-",
  ]);
});

test("crit → warn is quiet, relapse to crit alerts again", () => {
  const { events } = run(["crit", "warn", "crit"]);
  assert.deepEqual(events, ["alert:crit", "-", "alert:crit"]);
});

test("alertAfter debounces flapping health checks", () => {
  const { events } = run(["crit", "ok", "crit", "crit", "ok"], { alertAfter: 2 });
  assert.deepEqual(events, ["-", "-", "-", "alert:crit", "recover:ok"]);
});

test("errors alert only after failuresBeforeAlert in a row", () => {
  const { events } = run(["error", "error", "ok", "error", "error", "error", "ok"]);
  assert.deepEqual(events, ["-", "-", "-", "-", "-", "alert:error", "recover:ok"]);
});

test("auth failures alert at once and pause the check", () => {
  const { events, state } = run([result("error", { authFailed: true })]);
  assert.deepEqual(events, ["alert:error"]);
  assert.ok(state.suspendedUntil);
});

test("disabled / not configured checks never alert", () => {
  const { events } = run(["off", "off"]);
  assert.deepEqual(events, ["-", "-"]);
});

test("command parsing", () => {
  const config = { services: [{ id: "jev-fc-buddy" }, { id: "runway" }] };
  assert.deepEqual(parseCommand("", config), { type: "summary" });
  assert.deepEqual(parseCommand("<@U123> 总结一下", config), { type: "summary" });
  assert.deepEqual(parseCommand("jev-fc-buddy", config), { type: "summary", only: "jev-fc-buddy" });
  assert.deepEqual(parseCommand("总结 runway", config), { type: "summary", only: "runway" });
  assert.deepEqual(parseCommand("help", config), { type: "help" });
  assert.deepEqual(parseCommand("list", config), { type: "list" });
  assert.equal(parseCommand("blah", config).type, "unknown");
});

test("minIntervalMinutes reuses the last result (paid endpoints are not re-queried)", async () => {
  let calls = 0;
  CHECKS["test-paid"] = async () => ({ metric: { value: 100 + ++calls, unit: "credits" } });
  const service = { id: "s", name: "S", checks: [] };
  const opts = { timezone: "Asia/Shanghai" };
  const cached = { id: "paid", kind: "test-paid", name: "P", minIntervalMinutes: 60 };
  const a = await runCheck(service, cached, opts);
  const b = await runCheck(service, cached, opts);
  assert.equal(calls, 1);
  assert.equal(b.metric.value, a.metric.value);
  const fresh = { id: "free", kind: "test-paid", name: "F" };
  await runCheck(service, fresh, opts);
  await runCheck(service, fresh, opts);
  assert.equal(calls, 3);
  delete CHECKS["test-paid"];
});
