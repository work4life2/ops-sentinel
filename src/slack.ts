import { App, LogLevel } from "@slack/bolt";
import { parseCommand } from "./commands.js";
import { env } from "./env.js";
import { HELP, listMessage, summaryMessage, type SlackMessage } from "./report.js";
import type { CheckResult, Config } from "./types.js";

export interface Bot {
  post(message: SlackMessage): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BotDeps {
  config: Config;
  /** Fresh (or very recent) results for a summary request. */
  summarize(only?: string): Promise<CheckResult[]>;
  log(message: string): void;
}

/**
 * Slack app in Socket Mode: an outbound WebSocket, so the host needs no public URL or open port.
 * Env: SLACK_BOT_TOKEN (xoxb-), SLACK_APP_TOKEN (xapp-, connections:write), SLACK_CHANNEL_ID,
 * optional SLACK_COMMAND (default /ops), SLACK_ALLOWED_USERS (comma-separated user ids).
 */
export function createBot(deps: BotDeps): Bot {
  const token = env("SLACK_BOT_TOKEN");
  const appToken = env("SLACK_APP_TOKEN");
  const channel = env("SLACK_CHANNEL_ID");
  if (!token || !appToken || !channel) {
    throw new Error("需要 SLACK_BOT_TOKEN、SLACK_APP_TOKEN 和 SLACK_CHANNEL_ID（见 README 的 Slack 配置步骤），或用 --dry-run 只在终端输出");
  }
  const command = env("SLACK_COMMAND") ?? "/ops";
  const allowed = new Set((env("SLACK_ALLOWED_USERS") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const app = new App({ token, appToken, socketMode: true, logLevel: LogLevel.WARN });

  /** Turn command text into a reply. */
  async function answer(text: string, user: string | undefined): Promise<SlackMessage> {
    if (allowed.size && (!user || !allowed.has(user))) return plain("你没有使用这个机器人的权限（SLACK_ALLOWED_USERS）。");
    const cmd = parseCommand(text, deps.config);
    deps.log(`[slack] ${user ?? "?"}: ${JSON.stringify(text)} → ${cmd.type}`);
    if (cmd.type === "help") return plain(HELP);
    if (cmd.type === "list") return plain(listMessage(deps.config));
    if (cmd.type === "unknown") return plain(`没看懂 “${cmd.text}”。\n\n${HELP}`);
    const results = await deps.summarize(cmd.only);
    const name = cmd.only ? deps.config.services.find((s) => s.id === cmd.only)?.name : undefined;
    return summaryMessage(results, deps.config, new Date(), name ? `${name} 状态` : "运维总览");
  }

  app.command(command, async ({ command: c, ack, respond }) => {
    await ack({ response_type: "ephemeral", text: "正在检查，稍等…" });
    try {
      const reply = await answer(c.text ?? "", c.user_id);
      // Post as the bot so everyone in the channel sees it; response_url replies can stay
      // "only visible to you". Fall back to response_url where the bot is not a member.
      try {
        await app.client.chat.postMessage({
          channel: c.channel_id,
          text: reply.text,
          blocks: reply.blocks as never,
          unfurl_links: false,
        });
      } catch (err) {
        deps.log(`[slack] postMessage to ${c.channel_id} failed (${(err as Error).message}), using response_url`);
        await respond({ response_type: "in_channel", replace_original: false, ...reply });
      }
    } catch (err) {
      await respond({ response_type: "ephemeral", text: `出错了：${(err as Error).message}` });
    }
  });

  app.event("app_mention", async ({ event, say }) => {
    try {
      const reply = await answer(event.text ?? "", event.user);
      await say({ thread_ts: event.thread_ts ?? event.ts, ...reply });
    } catch (err) {
      await say({ thread_ts: event.ts, text: `出错了：${(err as Error).message}` });
    }
  });

  // Direct messages to the bot (App Home → Messages tab).
  app.event("message", async ({ event, say }) => {
    const m = event as { channel_type?: string; subtype?: string; bot_id?: string; text?: string; user?: string };
    if (m.channel_type !== "im" || m.subtype || m.bot_id) return;
    try {
      await say(await answer(m.text ?? "", m.user));
    } catch (err) {
      await say(`出错了：${(err as Error).message}`);
    }
  });

  return {
    async post(message) {
      await app.client.chat.postMessage({ channel, text: message.text, blocks: message.blocks as never, unfurl_links: false });
    },
    async start() {
      await app.start();
      deps.log(`[slack] connected (socket mode), command ${command}, channel ${channel}`);
    },
    async stop() {
      await app.stop();
    },
  };
}

function plain(text: string): SlackMessage {
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}
