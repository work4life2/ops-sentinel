import type { Config } from "./types.js";

export type Command =
  | { type: "summary"; only?: string }
  | { type: "help" }
  | { type: "list" }
  | { type: "unknown"; text: string };

const SUMMARY = ["", "status", "summary", "all", "check", "总结", "汇总", "状态", "情况", "全部"];
const HELP = ["help", "帮助", "?", "？"];
const LIST = ["list", "ls", "列表", "服务"];

/** Parse "/ops <text>", "@bot <text>" or a DM. Service ids win over keywords ("总结 jev-fc-buddy" → that service). */
export function parseCommand(input: string, config: Config): Command {
  const text = input.replace(/<@[A-Z0-9]+>/g, "").trim().toLowerCase();
  const service = config.services.find(
    (s) => text === s.id.toLowerCase() || text.split(/\s+/).includes(s.id.toLowerCase()),
  );
  if (service) return { type: "summary", only: service.id };
  if (HELP.includes(text)) return { type: "help" };
  if (LIST.includes(text)) return { type: "list" };
  if (SUMMARY.includes(text) || SUMMARY.some((k) => k && text.includes(k))) return { type: "summary" };
  return { type: "unknown", text };
}
