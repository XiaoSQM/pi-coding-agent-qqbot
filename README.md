# Pi Coding Agent QQBot

> Package/extension name: `pi-qqbot`

[中文](#中文说明) | [English](#english)

A Pi Coding Agent extension that connects the official QQ Bot API to a local Pi coding agent.
It lets an allowlisted QQ user send text, images, voice, and supported documents
to Pi and receive Pi's final assistant response back in QQ.

> Security warning: this extension turns QQ into a remote-control surface for
your local coding agent. Only allow QQ openids or groups that you fully trust.

---

## 中文说明

`pi-qqbot` 是一个 Pi 扩展，用官方 QQ 机器人 WebSocket 网关把 QQ 私聊/群聊消息接入本地 Pi coding agent。
QQ 用户发送文本或平台实际推送的附件后，扩展会在 allowlist 检查后安全预处理内容，并提交到独立的 QQ AgentSession；Pi 完成回复后，再通过 QQ 官方被动回复接口把最终内容发回 QQ。

### 功能

- QQ 文本、图片、语音和支持的文件 -> 独立 Pi AgentSession。
- C2C JPEG/PNG/GIF 通过 Pi 官方图片输入进入视觉模型；非视觉模型会明确拒绝，不会假装看图。
- 语音优先使用 QQ `asr_refer_text`，也可配置 OpenAI-compatible STT。
- 有界提取 UTF-8/UTF-16 TXT 与带文本层 PDF；DOC 仅识别并明确提示暂不提取正文。
- Pi 最终回复 -> QQ 被动回复。
- 富媒体以 QQ C2C 为可靠目标；群聊附件仅在 Gateway 实际推送时 best-effort 处理。
- 支持 allowlist，只允许指定 QQ openid / 群 openid 使用。
- QQ 在**独立会话**里运行，不污染、也不打断你本地正在用的 Pi 会话，两者可并行。
- 支持 QQ 侧 `/qqbot-status`、`/qqbot-last`、`/qqbot-help`。
- 可选把 QQ 中的斜杠输入交给独立 QQ 会话处理（`allowCommands`）。
- 默认使用 QQ 原生 Markdown，以“答案优先、短段落、语义分块”排版；平台拒绝时安全降级为保留换行的纯文本。
- 可选在最终答案之后附带精简执行摘要（`showProcess`）。
- 单 FIFO 队列，避免多条 QQ 消息并发时回复错投。

### 工作方式

```text
QQ 用户发送文本/附件
  -> QQ WebSocket Gateway 推送事件并标准化 attachments
  -> pi-qqbot 检查 allowlist、msg_id 去重
  -> HTTPS/SSRF/重定向/大小/超时保护下下载到 OS 临时目录
  -> 图片转 Pi images；语音转录；TXT/PDF 有界提取
  -> 交给独立的 QQ 专用 AgentSession 运行（SDK createAgentSession，noExtensions）
  -> 该会话产生最终 assistant 回复（本地 TUI 会话完全不受影响）
  -> pi-qqbot 捕获最终文本
  -> QQ 被动回复接口发送回原会话
```

### 安装

把本仓库放到 Pi 扩展目录，例如：

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
git clone https://github.com/wunaitianwang/pi-coding-agent-qqbot.git pi-qqbot
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
  "replyFormat": "auto",
  "media": {
    "enabled": true,
    "maxAttachments": 4,
    "maxTotalBytes": 31457280,
    "downloadTimeoutMs": 120000,
    "image": { "enabled": true, "maxBytes": 10485760 },
    "voice": { "enabled": true, "preferQQAsr": true, "maxBytes": 26214400 },
    "documents": {
      "enabled": true,
      "allowExtensions": [".txt", ".pdf", ".doc"],
      "maxTxtBytes": 2097152,
      "maxPdfBytes": 20971520,
      "maxDocBytes": 10485760,
      "maxPdfPages": 100,
      "maxExtractedChars": 150000
    }
  },
  "debug": false
}
```

字段说明：

- `enabled`: 是否启用扩展。默认 `false`。
- `autoStart`: 是否随 Pi 启动自动连接 QQ 网关。默认 `false`——不自动连，需用 `/qqbot-start` 手动打开（避免网络不通时开机狂刷重连报错）。
- `appId`, `clientSecret`: QQ 开放平台机器人凭据。不要提交到 Git。
- `sandbox`: `true` 使用 QQ 沙箱环境；正式环境设为 `false`。
- `allowUsers`: 允许使用机器人的 C2C 用户 openid 列表。
- `allowGroups`: 允许使用机器人的群 openid 列表。
- `allowCommands`: 是否允许从 QQ 转发非 `qqbot-*` 的 Pi 斜杠命令。
- `showProcess`: 是否在最终答案之后附带最多 6 条精简执行摘要。
- `replyFormat`: `auto` 优先发送 QQ 原生 Markdown并在格式被拒绝时回退纯文本；`plain` 始终发送纯文本。
- `media`: 富媒体总开关及数量、总大小、下载超时和分类型限制；数值会被安全硬上限 clamp。
- `media.image`: 图片开关和单图大小限制。
- `media.voice`: 语音开关、是否优先 QQ ASR、大小限制；即使未配置第三方 STT，QQ ASR 仍可工作。
- `media.documents`: 允许的 `.txt/.pdf/.doc`、单文件大小、PDF 页数和提取字符限制。
- `debug`: 是否开启本地调试通知和 `/qqbot-fake`。

可选 OpenAI-compatible STT 配置放在 `media.voice.stt`，密钥只从环境变量读取：

```json
"stt": {
  "baseUrl": "https://api.example.com/v1",
  "apiKeyEnv": "QQBOT_STT_API_KEY",
  "model": "whisper-1",
  "timeoutMs": 60000
}
```

然后在启动 Pi 前设置 `QQBOT_STT_API_KEY`。不要把密钥写入配置或提交到 Git。

安全默认值：如果 `allowUsers` 和 `allowGroups` 都为空，扩展不会处理或下载任何真实 QQ 入站附件。

### 本地 Pi 命令（在 Pi 终端里用）

- `/qqbot-start`: 连接 QQ 网关，并把 QQ 对话过程绑定到执行该命令的当前 Pi TUI 终端（`autoStart:false` 时用它手动打开）。
- `/qqbot-stop`: 断开 QQ 网关，并移除当前终端的 QQ 对话视图。
- `/qqbot-status`: 查看连接状态。
- `/qqbot-reconnect`: 强制重连（连不上重试 5 次后会自动停止，用这个重试）。

### QQ 侧命令

- `/qqbot-status`: 查看连接状态、队列长度、最近消息、最近错误。
- `/qqbot-last`: 查看最近 QQ 入站/出站摘要。
- `/qqbot-help`: 查看 QQ 可用命令。
- `/qqbot-fake <message>`: 仅 `debug: true` 时注册，本地模拟 QQ 入站消息，不会发送到 QQ。

普通文本会作为 Pi prompt 处理。例如在 QQ 中发送“查看当前目录文件”，Pi 会执行相应工具并把最终回复发回 QQ。纯附件消息也会入队，不会再被当作空消息忽略。

如果 `allowCommands: true`，QQ 中其他以 `/` 开头的输入会作为普通输入交给独立 QQ 会话处理（不影响本地会话）。会影响本地会话或需要本地交互的生命周期命令始终被拒绝，例如 `/new`、`/resume`、`/reload`、`/quit`、`/clear`、`/compact`、`/tree`、`/model`、`/login`。

### 富媒体范围与排障

- QQ 官方当前文件接收范围为 `txt`、`pdf`、`doc`。压缩包、DOCX 和视频不受支持，也不会自动解压或执行。
- PDF 仅提取文本层，不进行 OCR；扫描 PDF 会返回 `pdf_no_text`。
- DOC 首轮只识别并反馈 `doc_extraction_unsupported`，不会把二进制误当文本。
- 图片理解依赖隔离会话当前模型的 `input` 包含 `image`。
- 默认每条消息最多 4 个附件、总计 30 MiB；图片 10 MiB、语音 25 MiB、TXT 2 MiB、PDF 20 MiB/100 页、DOC 10 MiB。
- `/qqbot-status` 显示当前附件阶段和最近稳定错误码；常见错误包括 `invalid_url`、`ssrf_blocked`、`download_timeout`、`size_limit`、`mime_mismatch`、`parse_failed`、`pdf_no_text`、`stt_not_configured` 和 `stt_failed`。
- QQ 官方能力表目前不承诺群聊富媒体；若事件确实到达则走同一安全管线，但不保证平台会推送。

### 被动回复限制

QQ 官方机器人不能随意主动推送消息。普通回复必须引用用户原始消息的 `msg_id`：

- 单聊 C2C：60 分钟窗口；官方新旧文档存在每条消息 4/5 次的冲突表述。
- 群聊：5 分钟窗口；旧说明写每条消息最多 5 次。

插件采用更保守的 **最多 4 条**回复策略。可靠目标仍是单聊 C2C；群聊长任务可能因窗口过期失败。

### 运行过程可见性

在某个 Pi TUI 终端执行 `/qqbot-start` 后，该终端会显示一个最多 10 行的实时尾部视图，包括已授权 QQ 入站文本、排队/处理状态、Assistant 可见文本流、工具调用开始/结束以及 QQ 回复结果。该视图只存在于执行命令的 Pi 进程中：没有执行 `/qqbot-start` 的其他 Pi 终端不会显示这些内容。

终端视图使用 Pi 的 UI Widget/Status API，不调用本地会话的 `sendUserMessage`/`sendMessage`，不会写入本地会话 JSONL，也不会进入本地模型上下文。它不显示模型隐藏 thinking，也不显示完整工具输出。`autoStart: true` 只自动连接；仍需在目标 TUI 终端执行 `/qqbot-start` 才会附加视图。

开启 `showProcess: true` 后，QQ 回复会先显示最终答案，再在底部附加执行摘要：

```markdown
## 结论

检查已经完成，未发现异常。

***

## 执行摘要

- ✅ **bash**：`npm audit`
- ✅ **read**：配置文件
```

这不是实时逐步流式输出。插件会先规范化 Pi 的 Markdown，再按标题、段落、列表和完整代码块进行语义分块；不会在链接、Emoji 或代码围栏中间按固定字符数硬切。长回答最多发送 4 条，并使用“回答（1/3）”等低干扰编号。

### 安全注意

- 只允许可信 QQ openid / 群 openid。
- QQ 消息在**独立的 QQ 专用会话**里处理，不与本地终端会话共享上下文，也不会打断你本地的对话。该独立会话用 `noExtensions` 创建，不会再加载 pi-qqbot 自身。
- Pi 能访问的本机文件和命令，QQ 侧也可能通过 prompt 间接触发。
- 真实 `clientSecret`、access token、`~/.pi/agent/pi-qqbot.json` 不应提交到 GitHub。
- `showProcess` 会把工具名和关键参数（如命令、路径）放在最终答案后的执行摘要中；涉及敏感路径时建议关闭。
- QQ 排版默认采用：短回答不强加标题；普通回答按“结论 → 关键点/步骤 → 注意事项”；宽表格优先改为列表；风险用带文字标签的引用块表示。
- 附件只保存到 OS 临时目录，当前消息结束、失败或 stop 后删除；签名 URL、base64、正文和临时绝对路径不进入普通日志/status。
- 下载只允许公网 HTTPS，并校验 DNS 和每次重定向，执行流式大小限制、超时、有限重试和 AbortSignal。
- 附件正文作为不可信用户数据进入 prompt，不会提升为系统指令。

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
gateway to a local Pi coding agent. It receives QQ text and supported rich media,
prepares them under strict resource boundaries, submits them to an isolated QQ
AgentSession, and sends the final response back as an official passive reply.

### Features

- QQ text, images, voice, and supported documents -> isolated Pi AgentSession.
- C2C JPEG/PNG/GIF images use Pi's official image input; non-vision models are rejected explicitly.
- Voice prefers QQ `asr_refer_text`, with optional OpenAI-compatible STT.
- Bounded extraction for TXT and text-layer PDF; legacy DOC is identified but not misread as text.
- Pi final assistant response -> QQ passive reply.
- Reliable C2C private chat support; group chat is best-effort because of QQ's
  short passive-reply window.
- User and group allowlists.
- QQ runs in an **isolated agent session**, so it never pollutes or interrupts
  your local TUI session; the two can run in parallel.
- QQ-side `/qqbot-status`, `/qqbot-last`, and `/qqbot-help` commands.
- Optional handling of slash-prefixed input in the isolated QQ session
  (`allowCommands`).
- Native QQ Markdown with answer-first layout, semantic chunking, and safe plain-text fallback.
- Optional compact execution summary after the final answer (`showProcess`).
- Single FIFO queue to avoid response misrouting; QQ runs are serialized.

### How It Works

```text
QQ user sends text/attachments
  -> QQ WebSocket Gateway normalizes the event
  -> pi-qqbot checks the allowlist and deduplicates msg_id
  -> bounded public-HTTPS download and media preprocessing
  -> runs in a dedicated, isolated QQ agent session (SDK createAgentSession, noExtensions)
  -> that session produces the final assistant response (local TUI session untouched)
  -> pi-qqbot captures the final text
  -> QQ passive reply API sends it back to the original conversation
```

### Installation

Clone this repository into Pi's extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
git clone https://github.com/wunaitianwang/pi-coding-agent-qqbot.git pi-qqbot
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
  "replyFormat": "auto",
  "media": {
    "enabled": true,
    "maxAttachments": 4,
    "maxTotalBytes": 31457280,
    "downloadTimeoutMs": 120000,
    "image": { "enabled": true, "maxBytes": 10485760 },
    "voice": { "enabled": true, "preferQQAsr": true, "maxBytes": 26214400 },
    "documents": {
      "enabled": true,
      "allowExtensions": [".txt", ".pdf", ".doc"],
      "maxTxtBytes": 2097152,
      "maxPdfBytes": 20971520,
      "maxDocBytes": 10485760,
      "maxPdfPages": 100,
      "maxExtractedChars": 150000
    }
  },
  "debug": false
}
```

Fields:

- `replyFormat`: `auto` prefers native QQ Markdown and falls back to plain text when formatting is rejected; `plain` always sends plain text.
- `enabled`: Enables the extension. Default: false.
- `autoStart`: Connect the QQ gateway on Pi startup. Default: false — the gateway is opened on demand with `/qqbot-start` (prevents reconnect spam at startup when QQ is unreachable).
- `appId`, `clientSecret`: QQ Open Platform bot credentials. Never commit them.
- `sandbox`: Use QQ sandbox endpoints when true.
- `allowUsers`: Allowed C2C user openids.
- `allowGroups`: Allowed group openids.
- `allowCommands`: Forward non-`qqbot-*` Pi slash commands from QQ.
- `showProcess`: Append up to six compact execution-summary items after the final answer.
- `media`: Media switch plus bounded attachment count, total bytes, timeout, image, voice, and document limits. Numeric settings are clamped to hard safety caps.
- `debug`: Enable local debug notifications and `/qqbot-fake`.

Optional STT uses `media.voice.stt` with `baseUrl`, `apiKeyEnv`, `model`, and `timeoutMs`. The key is read only from the named environment variable (default `QQBOT_STT_API_KEY`), never from the example config.

Safe default: if both allowlists are empty, no real inbound QQ message is
processed or downloaded.

### Local Pi Commands (in the Pi terminal)

- `/qqbot-start`: Connect the QQ gateway and bind the live QQ conversation view to the current Pi TUI terminal that ran this command (use this when `autoStart:false`).
- `/qqbot-stop`: Disconnect the QQ gateway and remove this terminal's QQ conversation view.
- `/qqbot-status`: Show connection state.
- `/qqbot-reconnect`: Force a reconnect (auto-reconnect stops after 5 failed
  attempts; use this to retry).

### QQ-side Commands

- `/qqbot-status`: Show connection state, queue depth, recent messages, and last
  error.
- `/qqbot-last`: Show the latest inbound/outbound QQ summary.
- `/qqbot-help`: Show available QQ commands.
- `/qqbot-fake <message>`: Registered only when `debug: true`; simulates an
  inbound QQ message locally and does not send anything to QQ.

Plain text is treated as a Pi prompt. For example, sending “list the current
directory” from QQ asks Pi to perform the task and return the final answer.

When `allowCommands: true`, any other slash-prefixed input from QQ is handled as
input to the isolated QQ session (your local session is not affected).
Session-changing or interactive local commands are always refused, such as
`/new`, `/resume`, `/reload`, `/quit`, `/clear`, `/compact`, `/tree`, `/model`,
and `/login`.

### Rich-media Scope and Troubleshooting

- QQ currently documents inbound files as TXT, PDF, and DOC. Archives, DOCX, and video are rejected and never unpacked or executed.
- PDF support requires a text layer; OCR is not performed. DOC body extraction is intentionally unsupported in this release.
- Default limits: 4 attachments, 30 MiB total, 10 MiB/image, 25 MiB/voice, 2 MiB/TXT, 20 MiB and 100 pages/PDF, 10 MiB/DOC.
- `/qqbot-status` exposes the active attachment stage and the last stable error code, without URLs or body content.
- Group rich media is best-effort only because QQ's current capability table does not guarantee those inbound events.

### Passive Reply Limits

Official QQ bots cannot freely push arbitrary messages. Normal replies must
reference the user's original `msg_id`:

- C2C private chat: 60-minute window; current and historical QQ documentation conflict between 4 and 5 replies per inbound message.
- Group chat: 5-minute window; historical text states up to 5 replies.

The extension therefore uses a conservative maximum of **4 chunks**. C2C remains the reliable target; group replies are best-effort and may fail for long Pi turns.

### Process Visibility

After `/qqbot-start` is run in a Pi TUI terminal, that terminal shows a live tail view of up to 10 lines: authorized QQ inbound text, queue/run state, visible assistant text deltas, tool start/end state, and QQ reply delivery. The view is process-local: other Pi terminals that did not run `/qqbot-start` do not receive or display it.

The terminal view uses Pi's UI Widget/Status APIs. It does not call the local session's `sendUserMessage`/`sendMessage`, is not written to the local session JSONL, and is never included in the local model context. Hidden thinking and full tool output are not displayed. `autoStart: true` only connects automatically; run `/qqbot-start` in the target TUI terminal to attach the view.

With `showProcess: true`, the final answer stays first and a compact execution summary is appended at the bottom:

```markdown
## Result

The check completed without errors.

***

## Execution summary

- ✅ **bash**: `npm audit`
- ✅ **read**: configuration
```

This is not real-time streaming. Pi Markdown is normalized and split only at semantic boundaries such as headings, paragraphs, list items, and complete fenced-code blocks. Links, emoji, and code fences are not cut at arbitrary character positions. Long replies use low-noise labels such as `Answer (1/3)` and are capped at four chunks.

### Security Notes

- Only allow trusted QQ user/group openids.
- QQ messages run in a dedicated isolated agent session, separate from your
  local TUI session; they do not share its context or interrupt it. That session
  is created with `noExtensions` so it does not re-load pi-qqbot itself.
- Anything Pi can access locally may be indirectly triggered by a QQ prompt.
- Never commit the real `clientSecret`, access tokens, or
  `~/.pi/agent/pi-qqbot.json`.
- `showProcess` places tool names and key arguments after the answer; disable it for sensitive paths or commands.
- QQ replies are answer-first: short answers avoid unnecessary headings; normal answers use result → key points/steps → necessary cautions. Wide tables should become lists and warnings include a textual label instead of relying on emoji alone.
- Attachments live only in an OS temporary workspace and are deleted after success, failure, or stop.
- Downloads require public HTTPS and enforce DNS/redirect SSRF checks, streaming size limits, timeout, bounded retries, and cancellation.
- Signed URL queries, base64, extracted bodies, and temporary absolute paths are not shown in normal logs/status. Extracted content is marked as untrusted user data.

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
