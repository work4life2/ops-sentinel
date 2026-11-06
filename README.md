# ops-sentinel

接入 Slack 的运维机器人，主要做三件事：

1. 每 10 分钟查一遍所有服务的**配额/余额**和**运行状态**。快用完就往频道发告警：先报警告，变严重再报一次，之后每 6 小时提醒一次，恢复后发一条“已恢复”。
2. 在 Slack 里发 `/ops`（或 @机器人 “总结”，或私信它），它会立即汇总所有服务的当前情况。
3. 每天 09:30 自动发一份汇总。这份汇总同时当心跳用：哪天没收到，说明机器人自己挂了。

报告用表格输出，没有表情符号。**需要关注**一节放在最上面，列出所有异常和警告；表格里异常的格子加粗（终端里前面加 `*`）。

目前监控的内容：

| 服务 | 检查项 |
|---|---|
| 3D 卡牌 (holo-card-agent) | 服务在线、订单流水（进行中/待结算/结算/收入/失败/卡单/超期未结算）、热钱包 BNB |
| FC 游戏搭子 (jev-fc-buddy) | 服务在线、OpenRouter 余额 + 订单/收入/在线局数、热钱包 BNB |
| Montage Studio | 服务在线、四个 agent（Montage / RenderFarm / Beatsmith / Sketchboard）各自的订单流水和 7 天成本、四个热钱包 BNB |
| cun.ai | 账户余额（3D 卡牌和 Montage 共用；需要控制台的系统访问令牌） |
| Runway | 账户 credits：由 Montage 自己通过 Runway MCP 查询，读 `127.0.0.1:8795/api/runway/credits` |
| Mobula | 本期 credits = 套餐月额度 − 本期已用（`GET /api/2/usage`）；Termix 后端的 K 线和 logo 用 |

## 快速开始

```bash
npm ci
npm run build
cp .env.example .env.local      # 填密钥
node dist/index.js check         # 在终端跑一遍，不发 Slack、不改告警状态
node dist/index.js serve --dry-run   # 定时检查，告警只打印到终端
node dist/index.js test-alert    # 配好 Slack 后，往频道发一条测试消息
node dist/index.js serve         # 正式运行
npm test                         # 阈值 / 告警状态机 / 命令解析的单元测试
```

## Slack 配置（一次性）

1. 打开 <https://api.slack.com/apps> → **Create New App** → **From a manifest**，选工作区，粘贴 `deploy/slack-app-manifest.yml`。
2. **Basic Information → App-Level Tokens** → Generate，scope 选 `connections:write`，得到 `xapp-…` → `SLACK_APP_TOKEN`。
3. **Install App** → 安装到工作区，得到 `xoxb-…` → `SLACK_BOT_TOKEN`。
4. 在要接收告警的频道里输入 `/invite @ops-sentinel`，再从频道详情最下方复制频道 ID（`C…`）→ `SLACK_CHANNEL_ID`。
5. 可选：`SLACK_ALERT_MENTION=<!channel>`，严重告警会 @ 全频道；`SLACK_ALLOWED_USERS=U…,U…`，只允许这些人用命令（汇总里有收入数据）。

用的是 Socket Mode：机器人主动连 Slack，服务器不需要公网地址，也不用开端口。

## 命令

- `/ops`、`/ops 总结`：检查全部服务并汇总，结果发在频道里，所有人可见。
- `/ops jev-fc-buddy`：只看一个服务。
- `/ops list`：列出服务和检查项。
- `/ops help`：显示帮助。
- @机器人 或私信，说法一样，比如“现在什么情况”“总结一下 runway”。

## 配置

- `ops.config.json`：所有服务和检查项，**不放密钥**，可以提交到 git。
- `.env.local`：密钥，git 已忽略。配置里写 `${变量名}` 引用。缺变量的检查显示为“⚪ 未配置”，不会告警。

阈值有两种写法：数字是绝对值，单位跟检查项一致（USD / credits / BNB）；`"20%"` 是占总额的比例，只对能拿到总额的检查项有效。

全局参数：
- `intervalMinutes`：检查间隔，默认 10。
- `remindHours`：问题没解决时的重复提醒间隔，默认 6。
- `failuresBeforeAlert`：接口连续查失败几次才告警，默认 3。
- `dailySummaryAt`：每日汇总的时间（如 `"09:30"`）。不写就不发；目前已关闭，需要时用 `/ops` 手动看。
- `timezone`：时区。

单个检查项可以用 `alertAfter` 设连续几次异常才报警。`http-health` 默认是 2，用来过滤偶发的抖动。

查询本身要收费的接口（例如 Mobula 的用量接口，每次 1 credit），可以加 `minIntervalMinutes`：在这个间隔内直接复用上次的结果，`/ops` 也一样。Mobula 设的是 60，每月约 720 credits。

### 检查类型（kind）

| kind | 用途 | 关键参数 |
|---|---|---|
| `newapi` | New API 中转站（cun.ai 等） | `baseUrl`，`accessToken` + `userId`（查账户余额），`apiKey`（查 key 额度） |
| `openrouter` | OpenRouter 账户/key 余额 | `apiKey` |
| `runway` | Runway 开发者 API credits（api.dev.runwayml.com，现在没用到） | `apiKey` |
| `mobula` | Mobula 本期剩余 credits | `apiKey`，`organizationId` 或 `customerId`，`monthlyCredits`，`billingDay` |
| `montage-studio` | Montage 四个 agent 的订单流水 | `baseUrl`，`stuckHours` |
| `evm-balance` | 链上地址余额（gas），可选 ERC-20 | `address`，`rpcUrl`，`symbol`，`token`，`decimals` |
| `http-json` | **任意 JSON 余额接口，不用写代码** | `url`，`auth`/`headers`，`remainingPath`（或 `limitPath`+`usedPath`），`unit`，`scale` |
| `http-health` | HTTP 存活检查 | `url`，`okPath`，`fields` |
| `holo-card-agent` | 3dcardagent 订单流水 | `baseUrl`（面板地址），`auth`，`stuckMinutes`，`staleDeliveryDays` |
| `jev-fc-buddy` | jev 运营数据 + OpenRouter 余额 | `baseUrl`，`adminToken` |

### 接入新服务

- **有 JSON 余额接口的**：在 `ops.config.json` 里加一个 `http-json` 检查项就行。比如接口返回 `{"code":200,"data":100}`，就写 `"remainingPath": "data"`；`usdPerUnit` 可以在表格里顺带显示折合美元。
- **要特殊处理的**：在 `src/checks/` 加一个文件，导出 `(cfg) => Promise<Probe>`，再到 `src/checks/index.ts` 注册。配额类返回 `metric`，阈值和告警由框架处理；状态类自己返回 `level`。

## 部署到服务器

已经部署在 Linode 172.104.55.67 上，和被监控的服务在同一台机器：

| 项 | 值 |
|---|---|
| 目录 | `/opt/ops-sentinel`（用户 `opsbot`） |
| 服务 | `systemctl status ops-sentinel`，日志 `journalctl -fu ops-sentinel` |
| 密钥 | `/opt/ops-sentinel/.env.local`（600，部署不会覆盖） |
| 告警状态 | `/opt/ops-sentinel/data/state.json` |

**push 到 main 就是部署。** 服务器上的 `ops-sentinel-autodeploy.timer` 每分钟运行一次 `deploy/deploy.sh`：如果 origin/main 有新提交，就把代码重置到最新、`npm ci`、构建、更新 systemd unit，再重启服务。不需要 webhook，也不需要 GitHub secrets。`.env.local` 和 `data/` 都在 git 忽略列表里，部署时不会动它们。

| 操作 | 命令 |
|---|---|
| 看部署日志 | `journalctl -u ops-sentinel-autodeploy` |
| 强制重新部署 | `/opt/ops-sentinel/deploy/deploy.sh --force` |
| 新机器首次安装 | 用 root 运行 `deploy/server-bootstrap.sh`，再按 `.env.example` 填 `.env.local`，然后执行 `deploy.sh --force` |

**仓库是公开的**：密钥只能放在服务器的 `.env.local` 里，`ops.config.json` 里只能写 `${变量名}`。

在服务器上手动跑一遍检查：

```bash
cd /opt/ops-sentinel && runuser -u opsbot -- env HOME=/opt/ops-sentinel node dist/index.js check
```

### 注意事项

- **和被监控的服务在同一台机器上**：机器整个挂掉时，监控也跟着挂，不会有告警。每日汇总已关闭，所以没有心跳了：想确认它还活着，就在 Slack 里发一次 `/ops`；要恢复心跳，在配置里加回 `dailySummaryAt`。
- 三个服务都只监听 127.0.0.1，ops-sentinel 直接走本机访问，不经过 nginx / fail2ban。
- **凭据错了不会一直重试**：收到 401/403 时立即告警，并暂停这项检查 6 小时。这样做是为了避免 jev 那边的 fail2ban 把监控机的 IP 封掉。改好 `.env.local` 后重启 ops-sentinel，暂停会立即解除。
- **代理**：程序本身不读代理配置。本地调试时如果需要代理，`check` 可以临时加 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=…`。但只要加载了 Slack 模块（`serve`），Bolt 就会替换全局 fetch 的 dispatcher，这个代理方式会失效，所以 `serve` 请在能直连的服务器上跑。
