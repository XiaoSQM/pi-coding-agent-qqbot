# Pi Coding Agent QQBot

> Package/extension name: `@xsqm/pi-qqbot`

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
- 经授权的 QQ 管理员可让 Agent 通过 `qq_send_local_file` 把电脑中的 PNG/JPEG 或普通文件作为真实 QQ 富媒体消息发送到当前私聊，而不是只返回路径或 URL。
- 富媒体入站与本地文件出站以 QQ C2C 为可靠目标；群聊默认关闭或 best-effort。
- 支持 allowlist，只允许指定 QQ openid / 群 openid 使用。
- 每个 QQ 私聊/群聊作用域使用独立、持久化的 QQ AgentRuntime，不污染本地 Pi 会话，也不会在不同 QQ 对话间共享上下文。
- QQ 侧可真正执行 `/model`、`/thinking`、`/new`、`/sessions`、`/resume`、`/name`、`/compact` 和 `/stop`；命令直接调用 Pi SDK，不交给模型猜测。
- QQ 网关采用进程级宿主；本地 Pi 执行 `/new`、`/resume`、`/fork` 或 `/reload` 后自动交接，无需重新输入 `/qqbot-start`。
- 支持 QQ 原生指令按钮；按钮不可用时仍可复制相同文本命令。
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
  -> 交给独立、持久的 QQ AgentSessionRuntime 运行（SDK createAgentSessionRuntime，加载 host skills/MCP/插件，排除 pi-qqbot 自身）
  -> 若用户明确要求发送本地文件，Agent 调用 qq_send_local_file
  -> 插件校验管理员、允许目录、普通文件、格式、大小和回复配额
  -> QQ /files 以 base64 上传并取得 file_info，再以 msg_type=7 发到当前会话
  -> 该会话产生最终 assistant 回复（本地 TUI 会话完全不受影响）
  -> pi-qqbot 捕获最终文本和真实文件交付记录
  -> QQ 被动回复接口发送回原会话
```

### 安装

把本仓库放到 Pi 扩展目录，例如：

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
pi install npm:@xsqm/pi-qqbot
```

或从源码安装：

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
git clone https://github.com/XiaoSQM/pi-coding-agent-qqbot.git pi-qqbot
cd pi-qqbot
npm install
```

然后确认 Pi 的全局扩展配置启用了该扩展。如果你已经在 `~/.pi/agent/settings.json` 里启用了该扩展，重载 Pi 即可。

### 配置

复制示例配置到 Pi 配置目录：

```bash
cp ~/.pi/agent/extensions/pi-qqbot/pi-qqbot.json.example ~/.pi/agent/pi-qqbot.json
chmod 600 ~/.pi/agent/pi-qqbot.json
```

编辑 `~/.pi/agent/pi-qqbot.json`：

```json
{
  "schemaVersion": 3,
  "enabled": false,
  "startup": {
    "mode": "auto",
    "keepAcrossLocalSessions": true,
    "handoffGraceMs": 10000
  },
  "appId": "YOUR_QQBOT_APP_ID",
  "clientSecret": "YOUR_QQBOT_APP_SECRET",
  "sandbox": true,
  "allowUsers": [],
  "allowGroups": [],
  "replyPrefix": "",
  "maxQueueSize": 20,
  "sendBusyNotice": false,
  "commands": {
    "enabled": true,
    "accessRequests": true,
    "allowInGroups": false,
    "admins": [],
    "buttons": true,
    "maxListItems": 5,
    "modelPageSize": 6,
    "selectionTtlMs": 300000,
    "confirmationTtlMs": 120000
  },
  "sessions": {
    "mode": "persistent",
    "scope": "conversation",
    "restore": "recent",
    "maxResident": 8,
    "idleDisposeMs": 1800000
  },
  "showProcess": false,
  "replyFormat": "auto",
  "progress": {
    "enabled": true,
    "ackAfterMs": 3000
  },
  "outboundMedia": {
    "enabled": false,
    "adminsOnly": true,
    "allowPrivate": true,
    "allowGroups": false,
    "allowedRoots": [],
    "images": true,
    "files": true,
    "maxFilesPerTurn": 2,
    "maxImageBytes": 10485760,
    "maxFileBytes": 20971520,
    "maxTotalBytes": 31457280,
    "uploadTimeoutMs": 30000
  },
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

- `schemaVersion`: 配置格式版本。当前为 `3`；旧配置会按兼容规则读取，出站文件能力默认关闭。
- `enabled`: 是否启用扩展。默认 `false`。
- `startup.mode`: `auto` 随宿主 Pi 进程连接；`manual` 需本地 `/qqbot-start`；`service` 预留给独立服务宿主。默认 `auto`。
- `startup.keepAcrossLocalSessions`: 在本地 `/new`、`/resume`、`/fork`、`/reload` 时保持 QQ 网关和 QQ 会话。
- `appId`, `clientSecret`: QQ 开放平台机器人凭据。不要提交到 Git。
- `sandbox`: `true` 使用 QQ 沙箱环境；正式环境设为 `false`。
- `allowUsers`: 允许使用机器人的 C2C 用户 openid 列表。
- `allowGroups`: 允许使用机器人的群 openid 列表。
- `commands.enabled`: 开启 QQ SDK 管理命令。未知斜杠命令不会作为 prompt 转交给模型。
- `commands.accessRequests`: 未授权私聊用户发消息时创建 10 分钟待审批申请；附件在批准前不会下载。默认 `true`。
- `commands.admins`: 状态变更命令管理员。只有显式列入此数组的用户才有管理员权限；数组为空表示没有管理员，不再从 `allowUsers` 自动继承。
- `commands.allowInGroups`: 是否允许管理员在群聊改变群 QQ 会话状态。默认 `false`。
- `commands.buttons`: 为帮助、模型和会话列表附加 QQ 指令按钮。按钮使用平台通用点击权限，真实权限仍由服务端 allowlist/admin 校验；不要把 v2 openid 当作 Keyboard 的 `specify_user_ids`。
- `sessions.mode`: `persistent` 将 QQ 历史保存到独立目录；`memory` 仅用于临时测试。
- `sessions.restore`: 启动时恢复最近 QQ 会话或新建。
- `showProcess`: 是否在最终答案之后附带最多 6 条精简执行摘要。
- `progress.enabled`: 任务仍在执行超过 `progress.ackAfterMs` 时，发送一条“已收到，正在处理”的被动回执（占用 1 次回复配额）。
- `progress.ackAfterMs`: 慢任务回执延迟（毫秒）；`0` 表示任务一开始就发送。
- `replyFormat`: `auto` 优先发送 QQ 原生 Markdown并在格式被拒绝时回退纯文本；`plain` 始终发送纯文本。
- `outboundMedia`: 电脑本地文件到当前 QQ 会话的出站策略；这是独立的数据外传权限，默认关闭。
- `outboundMedia.adminsOnly`: 仅允许 `commands.admins` 中显式配置的用户调用发送工具。
- `outboundMedia.allowedRoots`: 显式允许发送的本地根目录；OS 临时目录始终可用，但 Agent cwd 不会自动获得权限。路径会经过 realpath、符号链接、普通文件和硬链接检查。
- `outboundMedia.allowGroups`: 是否允许群聊出站文件；默认关闭。
- `outboundMedia.max*`: 每回合数量、图片/文件单体大小、累计大小和上传超时；均有硬上限。
- `media`: QQ 到 Pi 的入站富媒体总开关及数量、总大小、下载超时和分类型限制；数值会被安全硬上限 clamp。
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

- `/qqbot-start`: 手动连接进程级 QQ 网关；`startup.mode:"auto"` 时通常无需执行。
- `/qqbot-stop`: 断开 QQ 网关，并移除当前终端的 QQ 对话视图。
- `/qqbot-status`: 查看连接状态。
- `/qqbot-runtime`: 查看当前加载的插件 build、Host schema、运行时启动时间、是否发生运行时替换和模型页大小；用于确认 `/reload` 已真正生效。
- `/qqbot-reconnect`: 强制重连（连不上重试 5 次后会自动停止，用这个重试）。
- `/qqbot-requests`: 用交互列表处理待审批 QQ 用户，可选“普通用户 / 管理员 / 拒绝”。
- `/qqbot-approve <申请码> <user|admin>`: 快速批准普通或管理员权限；管理员权限会再次确认。
- `/qqbot-deny <申请码>`: 拒绝申请，并对该用户设置一小时重复申请冷却。
- `/qqbot-revoke <user_openid>`: 经确认后同时移出普通和管理员白名单。

未授权用户首次私聊机器人时，插件只记录 OpenID 和消息元数据，不保存正文、不下载附件，并在 Pi 终端显示申请码。批准后会原子更新 `~/.pi/agent/pi-qqbot.json`、将权限立即应用到当前进程并通知用户，无需手工编辑配置或执行 `/reload`。

### QQ 侧命令

- `/help [命令]`: 查看 QQ Agent 命令与快捷按钮。
- `/status`: 查看当前 QQ 会话、模型、思考等级、队列和连接状态。
- `/model [查询|provider/model]`: 查看或切换 QQ 会话模型。无参数时分页显示；可发送 `/model page 2`，搜索结果可发送 `/model <查询> page 2`。
- `/thinking [等级]`: 查看或修改思考等级。
- `/new [名称]`: 新建持久 QQ 会话，旧会话保留。
- `/sessions [关键词]`: 查看或搜索当前 QQ 对话的历史会话。
- `/resume <短ID|唯一名称>`: 恢复 QQ 会话。
- `/name <名称>`: 命名当前 QQ 会话。
- `/compact [要求]`: 压缩当前 QQ 会话上下文。
- `/stop`: 中止当前 QQ 任务并移除该对话尚未处理的消息。
- `/last`: 查看最近 QQ 入站/出站摘要。
- `/qqbot-help`、`/qqbot-status`、`/qqbot-last` 保留为兼容别名。
- `/qqbot-fake <message>` 仍是仅主机调试命令，不从 QQ 注册。

普通文本会作为 Pi prompt 处理。例如在 QQ 中发送“查看当前目录文件”，Pi 会执行相应工具并把最终回复发回 QQ。纯附件消息也会入队，不会再被当作空消息忽略。启用 `outboundMedia` 后，管理员可发送“把刚生成的截图发给我”；Agent 必须调用 `qq_send_local_file`，只有 QQ API 确认成功后才会报告已发送。

QQ 命令只管理隔离的 **QQ 会话**，不会切换电脑终端中的本地 Pi 会话。`/login`、`/logout`、`/reload`、`/quit`、`/tree`、`/fork`、`/clone` 和原始 Shell 不允许从 QQ 执行。认证仍须在受信任主机完成。

### 富媒体范围与排障

- 本地文件出站首轮支持 PNG/JPEG 图片和普通文件，使用 QQ 官方 `file_data` 两步上传，不需要公网 URL。
- 出站目标固定为触发当前回合的 QQ 会话，模型不能提供或更改 OpenID、`msg_id`、`msg_seq`。
- 出站默认每回合最多 2 个文件：图片 10 MiB、普通文件 20 MiB、累计 30 MiB；媒体与最终文字共同使用每条入站消息的回复配额。
- 常见出站错误包括 `outbound_disabled`、`outbound_not_authorized`、`path_outside_allowed_roots`、`file_too_large`、`reply_budget_exhausted`、`media_upload_failed` 和 `media_send_unknown`。
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

启用扩展的 Pi TUI 会自动附加一个最多 10 行的实时尾部视图，包括已授权 QQ 入站文本、排队/处理状态、Assistant 可见文本流、工具调用开始/结束以及 QQ 回复结果。本地会话替换时旧视图会销毁，新视图自动重新附加，而进程级 QQ 网关保持运行。

终端视图只使用 Pi 的 UI Widget/Status API，不调用本地会话的 `sendUserMessage`/`sendMessage`，不会写入本地会话 JSONL，也不会进入本地模型上下文。它不显示模型隐藏 thinking，也不显示完整工具输出。

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
- QQ 消息在**独立的 QQ 专用会话**里处理，不与本地终端会话共享上下文，也不会打断你本地的对话。该独立会话会加载与本地 Pi 相同的 skills、MCP adapter 与其它插件/扩展，但会排除 pi-qqbot 自身以防递归。
- Pi 能访问的本机文件和命令，QQ 侧也可能通过 prompt 间接触发。
- 本地文件出站应保持 `adminsOnly:true`，并只配置必要的 `allowedRoots`；插件拒绝越界路径、符号链接目标、非普通文件和硬链接。
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
npm test
```

在 Pi 中执行：

```text
/reload
/qqbot-runtime
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
- Authorized QQ administrators can use the injected `qq_send_local_file` tool to deliver real local PNG/JPEG images or ordinary files to the current C2C chat instead of returning a path or URL.
- Reliable C2C private chat support; group chat is best-effort because of QQ's
  short passive-reply window.
- User and group allowlists.
- Each private/group scope gets an isolated, persistent QQ AgentRuntime, so QQ never pollutes the local TUI or another QQ conversation.
- Real QQ-side SDK commands: `/model`, `/thinking`, `/new`, `/sessions`, `/resume`, `/name`, `/compact`, and `/stop`.
- A process-level gateway host survives local `/new`, `/resume`, `/fork`, and `/reload` handoffs without another `/qqbot-start`.
- Native QQ command keyboards with copyable text-command fallback.
- Native QQ Markdown with answer-first layout, semantic chunking, and safe plain-text fallback.
- Optional compact execution summary after the final answer (`showProcess`).
- Single FIFO queue to avoid response misrouting; QQ runs are serialized.

### How It Works

```text
QQ user sends text/attachments
  -> QQ WebSocket Gateway normalizes the event
  -> pi-qqbot checks the allowlist and deduplicates msg_id
  -> bounded public-HTTPS download and media preprocessing
  -> runs in a dedicated, persistent QQ AgentSessionRuntime (SDK createAgentSessionRuntime; host skills/MCP/plugins enabled, pi-qqbot itself excluded)
  -> explicit local-file requests call qq_send_local_file
  -> the plugin enforces admin, root, regular-file, type, size, and reply-budget checks
  -> QQ /files uploads base64 and returns file_info; /messages sends msg_type=7
  -> that session produces the final assistant response (local TUI session untouched)
  -> pi-qqbot captures final text plus deterministic delivery records
  -> QQ passive reply API sends it back to the original conversation
```

### Installation

Clone this repository into Pi's extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
pi install npm:@xsqm/pi-qqbot
```

Or install from source:

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
git clone https://github.com/XiaoSQM/pi-coding-agent-qqbot.git pi-qqbot
cd pi-qqbot
npm install
```

Then make sure the extension is enabled in Pi's global extension settings. If
it is already enabled in `~/.pi/agent/settings.json`, reload Pi.

### Configuration

Copy the example config:

```bash
cp ~/.pi/agent/extensions/pi-qqbot/pi-qqbot.json.example ~/.pi/agent/pi-qqbot.json
chmod 600 ~/.pi/agent/pi-qqbot.json
```

Edit `~/.pi/agent/pi-qqbot.json`:

```json
{
  "schemaVersion": 3,
  "enabled": false,
  "startup": {
    "mode": "auto",
    "keepAcrossLocalSessions": true,
    "handoffGraceMs": 10000
  },
  "appId": "YOUR_QQBOT_APP_ID",
  "clientSecret": "YOUR_QQBOT_APP_SECRET",
  "sandbox": true,
  "allowUsers": [],
  "allowGroups": [],
  "replyPrefix": "",
  "maxQueueSize": 20,
  "sendBusyNotice": false,
  "commands": {
    "enabled": true,
    "accessRequests": true,
    "allowInGroups": false,
    "admins": [],
    "buttons": true,
    "maxListItems": 5,
    "modelPageSize": 6,
    "selectionTtlMs": 300000,
    "confirmationTtlMs": 120000
  },
  "sessions": {
    "mode": "persistent",
    "scope": "conversation",
    "restore": "recent",
    "maxResident": 8,
    "idleDisposeMs": 1800000
  },
  "showProcess": false,
  "replyFormat": "auto",
  "progress": {
    "enabled": true,
    "ackAfterMs": 3000
  },
  "outboundMedia": {
    "enabled": false,
    "adminsOnly": true,
    "allowPrivate": true,
    "allowGroups": false,
    "allowedRoots": [],
    "images": true,
    "files": true,
    "maxFilesPerTurn": 2,
    "maxImageBytes": 10485760,
    "maxFileBytes": 20971520,
    "maxTotalBytes": 31457280,
    "uploadTimeoutMs": 30000
  },
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

- `schemaVersion`: Persisted configuration format. Current value: `3`; legacy files remain compatible and outbound delivery stays disabled unless explicitly enabled.
- `replyFormat`: `auto` prefers native QQ Markdown and falls back to plain text when formatting is rejected; `plain` always sends plain text.
- `enabled`: Enables the extension. Default: false.
- `startup.mode`: `auto` connects with the host Pi process; `manual` requires local `/qqbot-start`; `service` is reserved for a standalone host.
- `startup.keepAcrossLocalSessions`: Keep the QQ gateway and QQ sessions across local `/new`, `/resume`, `/fork`, and `/reload`.
- `appId`, `clientSecret`: QQ Open Platform bot credentials. Never commit them.
- `sandbox`: Use QQ sandbox endpoints when true.
- `allowUsers`: Allowed C2C user openids.
- `allowGroups`: Allowed group openids.
- `commands.enabled`: Enable explicit SDK-backed QQ commands. Unknown slash input is never forwarded to the model.
- `commands.accessRequests`: Create a 10-minute local approval request when an unauthorized private user messages the bot; attachments are not downloaded before approval.
- `commands.admins`: Openids explicitly allowed to mutate QQ session state. An empty list means no administrators; ordinary `allowUsers` never inherit admin access.
- `commands.allowInGroups`: Permit configured admins to mutate a group QQ session. Default: false.
- `commands.buttons`: Add native QQ command buttons to help/model/session responses. Buttons use general click permission; the server-side allowlist/admin check remains authoritative because v2 openids are not valid Keyboard `specify_user_ids`.
- `sessions.mode`: `persistent` stores QQ-only history; `memory` is for temporary testing.
- `sessions.restore`: Continue the most recent QQ session or create a fresh one on runtime initialization.
- `showProcess`: Append up to six compact execution-summary items after the final answer.
- `progress.enabled`: Send one passive “processing” ack if a task is still running after `progress.ackAfterMs` (uses one reply slot).
- `progress.ackAfterMs`: Delay in milliseconds before the slow-task ack; `0` sends immediately when the run starts.
- `outboundMedia`: Local-computer-to-current-QQ delivery policy. This is a separate exfiltration permission and is disabled by default.
- `outboundMedia.adminsOnly`: Restrict the tool to explicit `commands.admins`.
- `outboundMedia.allowedRoots`: Explicitly allowed local roots. OS temp remains available, while the Agent cwd is not trusted automatically. Realpath, symlink, regular-file, and hard-link checks are enforced.
- `outboundMedia.allowGroups`: Permit group delivery; disabled by default.
- `outboundMedia.max*`: Per-turn count, per-image/file bytes, aggregate bytes, and upload timeout, all with hard caps.
- `media`: Inbound QQ-to-Pi media switch plus bounded attachment count, total bytes, timeout, image, voice, and document limits.
- `debug`: Enable local debug notifications and `/qqbot-fake`.

Optional STT uses `media.voice.stt` with `baseUrl`, `apiKeyEnv`, `model`, and `timeoutMs`. The key is read only from the named environment variable (default `QQBOT_STT_API_KEY`), never from the example config.

Safe default: if both allowlists are empty, no real inbound QQ message is
processed or downloaded.

### Local Pi Commands (in the Pi terminal)

- `/qqbot-start`: Manually connect the process-level QQ gateway; normally unnecessary with `startup.mode:"auto"`.
- `/qqbot-stop`: Disconnect the QQ gateway and remove this terminal's QQ conversation view.
- `/qqbot-status`: Show connection state.
- `/qqbot-runtime`: Show the active build, Host schema, runtime start time, replacement state, and model page size. Use it to verify a reload replaced the runtime.
- `/qqbot-reconnect`: Force a reconnect (auto-reconnect stops after 5 failed attempts; use this to retry).
- `/qqbot-requests`: Interactively grant ordinary-user/admin access or deny a pending request.
- `/qqbot-approve <code> <user|admin>`: Approve a request; admin grants require confirmation.
- `/qqbot-deny <code>`: Deny a request and apply a one-hour request cooldown.
- `/qqbot-revoke <user_openid>`: Remove both ordinary and admin access after confirmation.

An unauthorized private message creates a bounded request containing only the OpenID and event metadata; message text is not retained and attachments are not downloaded. Approval atomically updates `~/.pi/agent/pi-qqbot.json`, applies immediately without `/reload`, and notifies the user.

### QQ-side Commands

- `/help [command]`: Show QQ Agent commands and quick-action buttons.
- `/status`: Show the current QQ session, model, thinking level, queue, and connection.
- `/model [query|provider/model]`: List or switch the QQ session model. Lists are paginated; use `/model page 2`, or `/model <query> page 2` for search results.
- `/thinking [level]`: Show or change the thinking level.
- `/new [name]`: Create a persistent QQ session while retaining the old one.
- `/sessions [query]`: List/search this QQ conversation's sessions.
- `/resume <short-id|unique-name>`: Resume a QQ session.
- `/name <name>`: Name the current QQ session.
- `/compact [instructions]`: Compact the current QQ context.
- `/stop`: Abort this QQ conversation's current/pending work.
- `/last`: Show the latest inbound/outbound summary.
- `/qqbot-help`, `/qqbot-status`, and `/qqbot-last` remain compatibility aliases.

Plain text is treated as a Pi prompt. For example, sending “list the current
directory” from QQ asks Pi to perform the task and return the final answer. With
`outboundMedia` enabled, an administrator can ask “send me the screenshot you
just created”; the Agent must call `qq_send_local_file`, and success is reported
only after QQ confirms the media message.

QQ commands manage the isolated **QQ session**, never the local terminal session. `/login`, `/logout`, `/reload`, `/quit`, `/tree`, `/fork`, `/clone`, and raw shell execution remain unavailable remotely; authentication must be completed on a trusted host.

### Rich-media Scope and Troubleshooting

- Initial local outbound support covers PNG/JPEG images and ordinary files through QQ's official two-step base64 upload; no public URL is required.
- The outbound target is bound to the current QQ turn. The model cannot choose an OpenID, `msg_id`, or `msg_seq`.
- Defaults: two outbound files per turn, 10 MiB/image, 20 MiB/file, and 30 MiB aggregate. Media and final text share the passive-reply budget.
- Common outbound errors include `outbound_disabled`, `outbound_not_authorized`, `path_outside_allowed_roots`, `file_too_large`, `reply_budget_exhausted`, `media_upload_failed`, and `media_send_unknown`.
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

An enabled Pi TUI automatically attaches a live tail view of up to 10 lines: authorized QQ inbound text, queue/run state, visible assistant text deltas, tool start/end state, and QQ reply delivery. Local session replacement disposes the old view and automatically attaches a new one while the process-level QQ gateway stays online.

The terminal view uses Pi's UI Widget/Status APIs. It does not call the local session's `sendUserMessage`/`sendMessage`, is not written to the local session JSONL, and is never included in the local model context. Hidden thinking and full tool output are not displayed.

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
  loads host skills, MCP adapters, and other plugins/extensions, while excluding pi-qqbot itself to prevent recursion.
- Anything Pi can access locally may be indirectly triggered by a QQ prompt.
- Keep local outbound delivery on `adminsOnly:true` and configure only necessary `allowedRoots`; out-of-root paths, symlink targets, non-regular files, and hard links are rejected.
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
npm test
```

In Pi:

```text
/reload
/qqbot-runtime
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
