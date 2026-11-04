import type { AlertEvent } from "./alerts.js";
import { STATUS_KINDS } from "./checks/index.js";
import { amount, clock, LEVEL_LABEL } from "./format.js";
import { textTable } from "./textTable.js";
import type { CheckResult, Config, Level, OpsRow } from "./types.js";

const SEVERITY: Record<Level, number> = { crit: 4, error: 3, warn: 2, ok: 1, off: 0 };

export interface SlackMessage {
  text: string;
  blocks: Record<string, unknown>[];
}

/** A table cell; `flag` marks something abnormal (bold in Slack). */
interface Cell {
  text: string;
  flag?: boolean;
}

interface Table {
  title: string;
  header: string[];
  rows: Cell[][];
  /** Right-aligned (numeric) column indexes. */
  right: number[];
  /** Column that may wrap (long remarks). */
  wrap?: number;
}

/** Everything a summary shows, independent of where it is rendered. */
interface Report {
  title: string;
  counts: string;
  attention: { label: string; text: string }[];
  tables: Table[];
  idle: string[];
}

export function worst(results: CheckResult[]): Level {
  return results.reduce<Level>((w, r) => (SEVERITY[r.level] > SEVERITY[w] ? r.level : w), "off");
}

const cell = (text: string | number | undefined, flag = false): Cell => ({ text: text === undefined || text === "" ? "-" : String(text), flag });
const status = (level: Level): Cell => cell(LEVEL_LABEL[level], level !== "ok");

function buildReport(results: CheckResult[], config: Config, at: Date, title: string): Report {
  const live = results.filter((r) => r.level !== "off");
  const n = (l: Level) => results.filter((r) => r.level === l).length;
  const counts = [
    `共 ${live.length} 项检查：正常 ${n("ok")}`,
    ...(["warn", "crit", "error"] as Level[]).filter((l) => n(l)).map((l) => `${LEVEL_LABEL[l]} ${n(l)}`),
    ...(n("off") ? [`未配置 ${n("off")}`] : []),
  ].join("，");

  // Problems first: every non-ok check, then softer warnings the checks raised.
  const attention = live
    .filter((r) => r.level !== "ok")
    .sort((a, b) => SEVERITY[b.level] - SEVERITY[a.level])
    .map((r) => ({ label: LEVEL_LABEL[r.level], text: `${r.serviceName} / ${r.name}：${problemText(r)}` }));
  for (const r of live) for (const w of r.warnings) attention.push({ label: "注意", text: w });

  const serviceName = new Map(config.services.map((s) => [s.id, s.name]));
  const quotaRows = live
    .filter((r) => r.metric || !STATUS_KINDS.has(r.kind))
    .map((r) => [
      cell(serviceName.get(r.serviceId)),
      cell(r.name),
      status(r.level),
      cell(r.metric ? r.headline : "-", r.level === "warn" || r.level === "crit"),
      cell(r.warnText),
      cell(r.critText),
      cell(r.metric ? r.note : r.headline),
    ]);

  const opsRows: Cell[][] = [];
  for (const service of config.services) {
    const own = live.filter((r) => r.serviceId === service.id);
    const health = own.find((r) => r.kind === "http-health");
    const online = health ? cell(health.level === "ok" ? "在线" : health.level === "error" ? "检查失败" : "离线", health.level !== "ok") : cell("-");
    const rows: OpsRow[] = own.flatMap((r) => r.ops);
    if (!rows.length && health) rows.push({ label: service.name, note: health.note });
    for (const row of rows) opsRows.push(opsCells(row, online));
  }

  const tables: Table[] = [];
  if (quotaRows.length) {
    tables.push({ title: "额度 / 余额", header: ["服务", "项目", "状态", "当前", "警告线", "严重线", "说明"], rows: quotaRows, right: [3, 4, 5], wrap: 6 });
  }
  if (opsRows.length) {
    tables.push({ title: "服务运行", header: ["服务", "在线", "进行中", "待结算", "24h结算", "7天结算", "7天收入", "24h失败", "说明"], rows: opsRows, right: [2, 3, 4, 5, 6, 7], wrap: 8 });
  }

  const idle = results.filter((r) => r.level === "off").map((r) => `${r.serviceName} ${r.name}（${r.headline.replace(/^未配置：/, "")}）`);
  return { title: `${title}  ${clock(at, config.timezone)}`, counts, attention, tables, idle };
}

function opsCells(row: OpsRow, online: Cell): Cell[] {
  return [
    cell(row.label),
    online,
    cell(row.inFlight),
    cell(row.awaiting),
    cell(row.settled1d),
    cell(row.settled7d),
    cell(row.revenue7d === undefined ? undefined : amount(row.revenue7d, row.currency ?? "USDC")),
    cell(row.failed1d, (row.failed1d ?? 0) > 0),
    cell(row.note),
  ];
}

/** One-line description of what is wrong with a non-ok check. */
function problemText(r: CheckResult): string {
  if (r.metric && (r.level === "warn" || r.level === "crit")) {
    const line = r.level === "crit" ? r.critText : r.warnText;
    return `当前 ${r.headline}${line ? `，低于${r.level === "crit" ? "严重" : "警告"}线 ${line}` : ""}`;
  }
  return r.headline;
}

// ── Slack ────────────────────────────────────────────────────────────────

function slackCell(c: Cell, bold = false): Record<string, unknown> {
  if (!c.flag && !bold) return { type: "raw_text", text: c.text };
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: c.text, style: { bold: true } }] }] };
}

function slackTable(t: Table): Record<string, unknown> {
  // Slack rejects null entries here (despite the docs), so every column gets an explicit object.
  const columns = t.header.map((_, i) => (t.right.includes(i) ? { align: "right" } : i === t.wrap ? { align: "left", is_wrapped: true } : { align: "left" }));
  return {
    type: "table",
    column_settings: columns,
    rows: [t.header.map((h) => slackCell(cell(h), true)), ...t.rows.map((r) => r.map((c) => slackCell(c)))],
  };
}

export function summaryMessage(results: CheckResult[], config: Config, at = new Date(), title = "运维总览"): SlackMessage {
  const report = buildReport(results, config, at, title);
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: report.title } },
    { type: "context", elements: [{ type: "mrkdwn", text: report.counts }] },
  ];
  if (report.attention.length) {
    const lines = report.attention.map((a) => `• *${a.label}*　${a.text}`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(`*需要关注*\n${lines.join("\n")}`, 2900) } });
  }
  for (const t of report.tables) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${t.title}*` } });
    blocks.push(slackTable(t));
  }
  if (report.idle.length) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: clip(`未配置：${report.idle.join("；")}`, 2900) }] });
  }
  return { text: summaryText(report), blocks };
}

// ── Terminal / plain text ────────────────────────────────────────────────

function summaryText(report: Report): string {
  const parts = [report.title, report.counts];
  if (report.attention.length) parts.push(["需要关注", ...report.attention.map((a) => `  [${a.label}] ${a.text}`)].join("\n"));
  for (const t of report.tables) {
    const rows = [t.header, ...t.rows.map((r) => r.map((c) => (c.flag ? `*${c.text}` : c.text)))];
    parts.push(`${t.title}\n${textTable(rows, t.right)}`);
  }
  if (report.idle.length) parts.push(`未配置：${report.idle.join("；")}`);
  return parts.join("\n\n");
}

/** Plain-text summary for the CLI (abnormal cells are prefixed with "*"). */
export function summaryPlain(results: CheckResult[], config: Config, at = new Date(), title = "运维总览"): string {
  return summaryText(buildReport(results, config, at, title));
}

// ── Alerts ───────────────────────────────────────────────────────────────

/** One alert / reminder / recovery message. */
export function alertMessage(event: AlertEvent, mention?: string): SlackMessage {
  const r = event.result;
  const where = `${r.serviceName} / ${r.name}`;
  let label: string;
  if (event.type === "recover") label = "已恢复";
  else if (event.type === "remind") label = `仍未恢复·${LEVEL_LABEL[r.level]}`;
  else label = LEVEL_LABEL[r.level];

  const lines: string[] = [];
  if (event.type === "recover") {
    lines.push(`之前：${LEVEL_LABEL[event.previous ?? "warn"]}；现在：${r.metric ? r.headline : LEVEL_LABEL[r.level]}`);
  } else {
    lines.push(problemText(r) + (r.level === "error" && event.failures ? `（连续 ${event.failures} 次）` : ""));
    if (r.metric && r.note) lines.push(r.note);
    for (const w of r.warnings.slice(0, 3)) lines.push(w);
    if (r.authFailed && event.type === "alert") {
      lines.push("凭据被拒绝：已暂停这项检查，避免反复 401 触发 fail2ban 封 IP。改好 .env.local 后重启 ops-sentinel。");
    }
  }
  const urgent = event.type === "alert" && (r.level === "crit" || r.authFailed);
  const title = `*[${label}]* ${where}`;
  const text = [urgent && mention ? `${mention} ${title}` : title, ...lines].join("\n");
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text: clip(text, 2900) } }] };
}

export const HELP = [
  "*ops-sentinel 命令*",
  "• `/ops` 或 `/ops 总结`：立即检查所有服务并汇总",
  "• `/ops <服务id>`：只看一个服务，例如 `/ops montage-studio`",
  "• `/ops list`：列出所有服务和检查项",
  "• `/ops help`：显示本帮助",
  "也可以在频道里 @我，或私信我发「总结」/ 服务id。",
].join("\n");

export function listMessage(config: Config): string {
  return config.services
    .map((s) => `*${s.name}*  \`${s.id}\`${s.enabled === false ? "（停用）" : ""}\n${s.checks.map((c) => `　• ${c.name}  \`${c.kind}\`${c.enabled === false ? "（停用）" : ""}`).join("\n")}`)
    .join("\n");
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Slack mrkdwn → terminal text. */
export function toPlain(text: string): string {
  return text.replace(/\*([^*\n]+)\*/g, "$1").replace(/(^|\s)_([^_\n]+)_/g, "$1$2").replace(/`([^`]+)`/g, "$1");
}
