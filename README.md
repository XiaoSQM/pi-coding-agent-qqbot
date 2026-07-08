# pi-qqbot

[中文](#中文说明) | [English](#english)

A Pi extension that connects the official QQ Bot API to a local Pi coding agent.
It lets an allowlisted QQ user send text messages to Pi and receive Pi's final
assistant response back in QQ.

> Security warning: this extension turns QQ into a remote-control surface for
your local coding agent. Only allow QQ openids or groups that you fully trust.

---

## 中文说明

`pi-qqbot` 是一个 Pi 扩展，用官方 QQ 机器人 WebSocket 网关把 QQ 私聊/群聊文本消息接入本地 Pi coding agent。
QQ 用户发消息后，扩展会把消息注入到当前 Pi 会话；Pi 完成回复后，扩展再通过 QQ 官方被动回复接口把最终内容发回 QQ。

### 功能

- QQ 文本消息 -> Pi 用户消息。
- Pi 最终回复 -> QQ 被动回复。
- 支持 QQ 单聊 C2C；群聊可用但受 5 分钟被动回复窗口限制。
- 支持 allowlist，只允许指定 QQ openid / 群 openid 使用。
- 支持 QQ 侧 `/qqbot-status`、`/qqbot-last`、`/qqbot-help`。
- 可选把 QQ 中的 Pi 斜杠命令转发到本地 Pi（`allowCommands`）。
- 可选在 QQ 回复中附带工具调用过程摘要（`showProcess`）。
- 单 FIFO 队列，避免多条 QQ 消息并发时回复错投。

### 工作方式

```text
QQ 用户发送文本
  -> QQ WebSocket Gateway 推送事件
  -> pi-qqbot 检查 allowlist
  -> pi.sendUserMessage() 注入 Pi 当前会话
  -> Pi 运行并产生最终 assistant 回复
  -> pi-qqbot 在 agent_end 捕获最终文本
  -> QQ 被动回复接口发送回原会话
```

### 安装

把本仓库放到 Pi 扩展目录，例如：

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
git clone <YOUR_REPO_URL> pi-qqbot
cd pi-qqbot
npm install
```

然后确认 Pi 的全局扩展配置启用了 `pi-qqbot`。如果你已经在 `~/.pi/agent/settings.json` 里启用了该扩展，重载 Pi 即可。

### 配置

复制示例配置到 Pi 配置目录：

```bash
cp ~/.pi/agent/extensions/pi-qqbot/pi-qqbot.json.example ~/.pi/agent/pi-qqbot.json
chmod 600 ~/.pi/agent/pi-qqbot.json
```

编辑 `~/.pi/agent/pi-qqbot.json`：

```json
{
  "enabled": false,
  "appId": "YOUR_QQBOT_APP_ID",
  "clientSecret": "YOUR_QQBOT_APP_SECRET",
  "sandbox": true,
  "allowUsers": [],
  "allowGroups": [],
  "replyPrefix": "",
  "maxQueueSize": 20,
  "sendBusyNotice": false,
  "allowCommands": false,
  "showProcess": false,
  "debug": false
}
```

字段说明：

- `enabled`: 是否启动 QQ 网关连接。默认 `false`。
- `appId`, `clientSecret`: QQ 开放平台机器人凭据。不要提交到 Git。
- `sandbox`: `true` 使用 QQ 沙箱环境；正式环境设为 `false`。
- `allowUsers`: 允许使用机器人的 C2C 用户 openid 列表。
- `allowGroups`: 允许使用机器人的群 openid 列表。
- `allowCommands`: 是否允许从 QQ 转发非 `qqbot-*` 的 Pi 斜杠命令。
- `showProcess`: 是否在 QQ 回复里附带工具调用过程摘要。
- `debug`: 是否开启本地调试通知和 `/qqbot-fake`。

安全默认值：如果 `allowUsers` 和 `allowGroups` 都为空，扩展不会处理任何真实 QQ 入站消息。

### QQ 侧命令

- `/qqbot-status`: 查看连接状态、队列长度、最近消息、最近错误。
- `/qqbot-last`: 查看最近 QQ 入站/出站摘要。
- `/qqbot-help`: 查看 QQ 可用命令。
- `/qqbot-fake <message>`: 仅 `debug: true` 时注册，本地模拟 QQ 入站消息，不会发送到 QQ。

普通文本会作为 Pi prompt 处理。例如在 QQ 中发送“查看当前目录文件”，Pi 会执行相应工具并把最终回复发回 QQ。

如果 `allowCommands: true`，QQ 中的已知 Pi 斜杠命令会被转发到本地 Pi。注意：Pi 斜杠命令的输出通常显示在本地 TUI，无法通用回传 QQ。会影响会话或需要本地交互的命令会被拒绝，例如 `/new`、`/resume`、`/reload`、`/quit`、`/clear`、`/compact`、`/tree`、`/model`、`/login`。

### 被动回复限制

QQ 官方机器人不能随意主动推送消息。普通回复必须引用用户原始消息的 `msg_id`：

- 单聊 C2C：60 分钟窗口，每条入站消息最多 5 条回复。
- 群聊：5 分钟窗口，每条入站消息最多 5 条回复。

因此本项目的可靠 MVP 是单聊 C2C。群聊回复属于 best-effort，长任务可能因窗口过期失败。

### 运行过程可见性

开启 `showProcess: true` 后，QQ 回复会包含工具调用摘要，例如：

```text
🔧 执行过程:
1. bash: ls -la /tmp ✓
2. read: /etc/hosts ✓
—— 回复 ——
完成了。
```

这不是 remote-pi 那种实时逐步流式输出。QQ 平台有每条消息最多 5 条被动回复的硬限制，所以本扩展采用“聚合过程 + 最终回复”的方式。

### 安全注意

- 只允许可信 QQ openid / 群 openid。
- QQ 消息会进入同一个本地 Pi 会话，和本地终端用户共享上下文。
- Pi 能访问的本机文件和命令，QQ 侧也可能通过 prompt 间接触发。
- 真实 `clientSecret`、access token、`~/.pi/agent/pi-qqbot.json` 不应提交到 GitHub。
- `showProcess` 会把工具名和关键参数（如命令、路径）发到 QQ；涉及敏感路径时建议关闭。

### 开发与验证

```bash
cd ~/.pi/agent/extensions/pi-qqbot
npm install
```

在 Pi 中执行：

```text
/reload
/qqbot-status
```

QQ 中可发送：

```text
/qqbot-help
/qqbot-status
你好，介绍一下当前会话
```

### 许可

Apache License 2.0。详见 [LICENSE](LICENSE)。

---

## English

`pi-qqbot` is a Pi extension that connects the official QQ Bot API WebSocket
gateway to a local Pi coding agent. It receives QQ text messages, injects them
into the current Pi session, captures Pi's final assistant response, and sends it
back to QQ as an official passive reply.

### Features

- QQ text message -> Pi user message.
- Pi final assistant response -> QQ passive reply.
- Reliable C2C private chat support; group chat is best-effort because of QQ's
  short passive-reply window.
- User and group allowlists.
- QQ-side `/qqbot-status`, `/qqbot-last`, and `/qqbot-help` commands.
- Optional forwarding of Pi slash commands from QQ (`allowCommands`).
- Optional tool-call process summary in QQ replies (`showProcess`).
- Single FIFO queue to avoid response misrouting while Pi handles one turn at a
  time.

### How It Works

```text
QQ user sends text
  -> QQ WebSocket Gateway delivers the event
  -> pi-qqbot checks the allowlist
  -> pi.sendUserMessage() injects it into the current Pi session
  -> Pi runs and produces the final assistant response
  -> pi-qqbot captures final text on agent_end
  -> QQ passive reply API sends it back to the original conversation
```

### Installation

Clone this repository into Pi's extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
git clone <YOUR_REPO_URL> pi-qqbot
cd pi-qqbot
npm install
```

Then make sure the extension is enabled in Pi's global extension settings. If
`pi-qqbot` is already enabled in `~/.pi/agent/settings.json`, reload Pi.

### Configuration

Copy the example config:

```bash
cp ~/.pi/agent/extensions/pi-qqbot/pi-qqbot.json.example ~/.pi/agent/pi-qqbot.json
chmod 600 ~/.pi/agent/pi-qqbot.json
```

Edit `~/.pi/agent/pi-qqbot.json`:

```json
{
  "enabled": false,
  "appId": "YOUR_QQBOT_APP_ID",
  "clientSecret": "YOUR_QQBOT_APP_SECRET",
  "sandbox": true,
  "allowUsers": [],
  "allowGroups": [],
  "replyPrefix": "",
  "maxQueueSize": 20,
  "sendBusyNotice": false,
  "allowCommands": false,
  "showProcess": false,
  "debug": false
}
```

Fields:

- `enabled`: Starts the QQ gateway connection when true. Default: false.
- `appId`, `clientSecret`: QQ Open Platform bot credentials. Never commit them.
- `sandbox`: Use QQ sandbox endpoints when true.
- `allowUsers`: Allowed C2C user openids.
- `allowGroups`: Allowed group openids.
- `allowCommands`: Forward non-`qqbot-*` Pi slash commands from QQ.
- `showProcess`: Include a compact tool-call transcript in QQ replies.
- `debug`: Enable local debug notifications and `/qqbot-fake`.

Safe default: if both allowlists are empty, no real inbound QQ message is
processed.

### QQ-side Commands

- `/qqbot-status`: Show connection state, queue depth, recent messages, and last
  error.
- `/qqbot-last`: Show the latest inbound/outbound QQ summary.
- `/qqbot-help`: Show available QQ commands.
- `/qqbot-fake <message>`: Registered only when `debug: true`; simulates an
  inbound QQ message locally and does not send anything to QQ.

Plain text is treated as a Pi prompt. For example, sending “list the current
directory” from QQ asks Pi to perform the task and return the final answer.

When `allowCommands: true`, known Pi slash commands can be forwarded from QQ.
Their output usually appears in the local Pi TUI and cannot be generically sent
back to QQ. Session-changing or interactive commands are always refused, such as
`/new`, `/resume`, `/reload`, `/quit`, `/clear`, `/compact`, `/tree`, `/model`,
and `/login`.

### Passive Reply Limits

Official QQ bots cannot freely push arbitrary messages. Normal replies must
reference the user's original `msg_id`:

- C2C private chat: 60-minute window, up to 5 replies per inbound message.
- Group chat: 5-minute window, up to 5 replies per inbound message.

For this reason, the reliable MVP target is C2C private chat. Group replies are
best-effort and may fail for long Pi turns.

### Process Visibility

With `showProcess: true`, replies include a compact tool-call summary:

```text
🔧 Process:
1. bash: ls -la /tmp ✓
2. read: /etc/hosts ✓
—— Reply ——
Done.
```

This is not real-time remote-pi style streaming. QQ has a hard cap of 5 passive
replies per inbound message, so the extension aggregates the process transcript
and final answer into a small number of replies.

### Security Notes

- Only allow trusted QQ user/group openids.
- QQ messages are injected into the same local Pi session and share its context.
- Anything Pi can access locally may be indirectly triggered by a QQ prompt.
- Never commit the real `clientSecret`, access tokens, or
  `~/.pi/agent/pi-qqbot.json`.
- `showProcess` sends tool names and key arguments, such as shell commands or
  file paths, back to QQ; disable it for sensitive tasks.

### Development & Verification

```bash
cd ~/.pi/agent/extensions/pi-qqbot
npm install
```

In Pi:

```text
/reload
/qqbot-status
```

From QQ:

```text
/qqbot-help
/qqbot-status
Hello, summarize the current session
```

### License

Apache License 2.0. See [LICENSE](LICENSE).
