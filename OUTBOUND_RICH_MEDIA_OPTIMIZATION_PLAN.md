# pi-qqbot 本地文件出站优化计划

> 文档状态：待确认，当前仅完成调研与规划，尚未修改功能代码  
> 项目基线：`@xsqm/pi-qqbot` v0.4.6  
> 目标场景：QQ 用户要求 Pi 查找、生成或选择电脑中的图片/文件后，插件把真实文件作为 QQ 富媒体消息发送到当前手机 QQ 会话，而不是只回复本地路径或 URL。

## 1. 结论与目标

当前插件已经支持 QQ 附件进入 Pi，但出站只有纯文本和 Markdown。模型即使回复“已发送”，插件也没有上传本地文件，因此不同模型会出现“有的声称能发、有的只给 URL”的不一致。

本次优化的核心不是继续强化提示词，而是增加一条由插件控制的确定性链路：

```text
QQ 用户提出发送要求
  -> QQ 隔离 Agent 调用 qq_send_local_file 工具
  -> 插件解析并校验本地路径
  -> 读取文件并转为 base64
  -> QQ /files 上传接口返回 file_info
  -> QQ /messages 以 msg_type=7 发送到当前会话
  -> 工具只在 QQ API 成功后返回“发送成功”
  -> Agent 再发送简短文字结果
```

目标结果：

- 图片在手机 QQ 中显示为真实图片消息，而不是 Markdown 链接。
- 普通文件在手机 QQ 中显示为真实文件消息，而不是电脑路径。
- 发送目标固定为触发当前 Agent 回合的 QQ 私聊/群聊，模型不能指定其他 OpenID。
- 高低能力模型都使用同一个简单工具，不需要理解 QQ 上传协议。
- QQ API 未确认成功时，插件和模型都不能把结果表述为“已发送”。

## 2. 当前问题

### 2.1 已确认的代码缺口

- `qq-api.ts` 只有 `sendText()` 和 `sendMarkdown()`。
- `router.ts` 只发送 Agent 的最终文本，没有富媒体交付队列。
- `qq-session.ts` 没有向隔离 Agent 注入 QQ 文件发送工具。
- 当前 `media` 配置只管理 QQ 到 Pi 的入站附件。
- 当前终端视图没有出站文件上传和发送状态。

### 2.2 模型表现不一致的根因

模型目前只能访问通用文件和 Shell 工具，但没有“把这个本地文件发到当前 QQ”的明确能力。它可能：

- 返回本地绝对路径，但手机无法访问；
- 返回网页图片 URL，但没有把文件作为 QQ 消息发送；
- 生成 Markdown 图片语法，受 QQ URL 白名单和 Markdown 能力限制；
- 口头声称已经发送，但实际上没有调用任何 QQ 富媒体接口。

因此，继续依赖模型输出某种文本格式不能解决根因。插件必须提供结构化工具并掌握最终交付结果。

## 3. QQ 官方接口依据

### 3.1 富媒体上传

QQ 官方文档要求发送图片、视频、语音或文件前先调用上传接口：

- 单聊：`POST /v2/users/{openid}/files`
- 群聊：`POST /v2/groups/{group_openid}/files`

主要请求字段：

- `file_type: 1`：图片，官方列出 PNG/JPG；
- `file_type: 2`：视频，官方列出 MP4；
- `file_type: 3`：语音，官方列出 SILK/WAV/MP3/FLAC；
- `file_type: 4`：普通文件；
- `url`：平台可拉取的公网资源地址；
- `file_data`：文件二进制的 base64；
- `srv_send_msg: false`：只上传并取得 `file_info`，不直接占用主动消息频次发送。

上传响应中的关键字段：

- `file_uuid`：文件 ID；
- `file_info`：后续消息接口 `media.file_info` 使用的值；
- `ttl`：`file_info` 剩余有效期。

本项目优先采用 `file_data`，因为目标是发送电脑本地文件，且不应为了上传临时启动公网 HTTP 服务或第三方隧道。

### 3.2 富媒体消息发送

上传成功后调用现有会话对应的消息接口：

- 单聊：`POST /v2/users/{openid}/messages`
- 群聊：`POST /v2/groups/{group_openid}/messages`

消息体使用：

```json
{
  "msg_type": 7,
  "media": { "file_info": "UPLOAD_RESPONSE_FILE_INFO" },
  "msg_id": "CURRENT_INBOUND_MESSAGE_ID",
  "msg_seq": 1
}
```

群聊接口要求 `content`，发送纯媒体时沿用插件现有兼容策略传入一个空白占位。

### 3.3 被动回复约束

- C2C 被动回复窗口为 60 分钟。
- 群聊被动回复窗口为 5 分钟。
- 当前官方更新说明把 C2C 每条入站消息调整为最多 4 次回复，但页面历史段落仍存在 4/5 次冲突。
- 插件继续采用保守的最多 4 次策略。
- `/files` 上传本身不是最终消息；`/messages` 的媒体发送会占用一次回复序号和配额。

### 3.4 实施前必须实测的官方文档歧义

官方字段表把 `url` 标成必填，同时又提供 `file_data`。实施第一阶段必须在 QQ 沙箱验证：

- 仅传 `file_data` 是否被当前接口接受；
- `file_data` 与 `url` 是否严格互斥；
- 普通文件使用 `file_data` 时是否保留原文件名；
- 各媒体类型的真实大小限制和错误码；
- 沙箱与正式环境是否一致。

如果平台拒绝纯 `file_data`，应先报告真实错误并重新确认方案，不能擅自创建公网隧道作为替代。

## 4. 范围规划

### 4.1 第一阶段必须完成

- C2C 私聊发送本地 PNG/JPG 图片。
- C2C 私聊发送普通本地文件。
- 从相对路径和绝对路径解析文件。
- 专用 Agent 工具 `qq_send_local_file`。
- 插件控制目标会话、权限、路径、大小、回复序号和错误处理。
- 工具发送结果进入终端过程视图和 `showProcess` 摘要。
- QQ 沙箱真实发送测试。

这覆盖用户最常见的工作流：

```text
“搜索一张图片并发给我”
“把刚才生成的截图发到 QQ”
“把 C:\...\report.pdf 发给我”
“找到项目里的日志并发给我”
```

### 4.2 第二阶段扩展

- 群聊图片和文件发送。
- 多文件连续发送。
- 语音和视频类型。
- `file_info` 的 TTL 内缓存复用。
- 平台支持并验证后再考虑大文件分片上传。

### 4.3 本轮明确不做

- 不根据 Assistant 最终文本中的路径正则自动发送文件。
- 不把本地文件复制到 Web 目录并生成临时 HTTP URL。
- 不自动启动 Cloudflare Tunnel、ngrok 或其他公网隧道。
- 不允许模型传入 QQ OpenID 或改变发送目标。
- 不发送目录、设备文件、FIFO、Socket 或符号链接指向的越权文件。
- 不因上传失败而退化成“只发 URL”并假装任务完成。
- 不自动发送模型没有明确选择的所有搜索结果。

## 5. 目标架构

### 5.1 分层设计

```text
QQAgentSession
  └─ customTools: qq_send_local_file
       └─ OutboundDeliveryContext（当前 Agent run 专属）
            ├─ LocalFilePolicy：路径、权限、类型、大小校验
            ├─ QQApi.uploadMedia：上传 base64，获取 file_info
            ├─ ReplyBudget：预留并分配 msg_seq
            └─ QQApi.sendMedia：msg_type=7 被动回复

PiQQBotRuntime
  ├─ 创建每个 run 的 DeliveryContext
  ├─ 保存当前 QQReplyTarget，不暴露给模型
  ├─ 记录实际成功/失败的交付清单
  ├─ 控制最终文本剩余回复配额
  └─ 在 run 结束时关闭 Context，拒绝迟到调用
```

### 5.2 为什么使用专用工具

工具定义保持简单：

```text
qq_send_local_file(path, kind="auto")
```

建议参数：

- `path`：必填，本地文件路径；
- `kind`：可选，`auto | image | file`，默认 `auto`；
- `caption`：首轮不加入，避免低能力模型混淆媒体消息和最终文字回复。

不提供这些参数：

- `userOpenId` / `groupOpenId`；
- `msgId` / `msgSeq`；
- `fileInfo`；
- QQ API URL 或 token。

工具描述必须明确：当用户要求“发送、上传、传给我”本地图片或文件时调用此工具；本地路径、Markdown 链接和普通 URL 都不能代替工具调用。

### 5.3 运行上下文绑定

隔离 QQ 会话会跨多个用户回合持续存在，而每个入站消息都有不同的 `msg_id`。因此不能把某次消息目标永久闭包进工具。

每次 `qq.run()` 前创建一个带唯一 run token 的 `OutboundDeliveryContext`：

- 工具执行时只能获取当前活动 Context；
- Context 持有当前 `QQReplyTarget`、AbortSignal 和回复预算；
- Agent 回合结束或 `/stop` 后立即失效；
- 工具迟到调用返回稳定错误，不会把文件发到下一条 QQ 消息；
- 当前 Router 是单 FIFO，但仍保留 run token 校验，避免未来并发改造引入错投。

## 6. 安全与权限设计

把电脑文件发送到 QQ 属于数据外传能力，安全级别高于读取文件。必须在插件层做强制策略，不能只依赖 prompt。

### 6.1 用户权限

建议默认：

- `outboundMedia.enabled: false`，升级后不自动打开；
- `outboundMedia.adminsOnly: true`；
- 只有 `commands.admins` 中显式配置的 QQ 用户可以发送本地文件；
- 群聊首轮禁用；
- 未授权调用在读取文件前拒绝。

完成代码后，再为当前受信任私聊用户显式启用，避免升级时给所有现有 allowlist 用户新增文件外传权限。

### 6.2 路径边界

默认允许根目录：

- 当前 QQ Agent 的 `cwd`；
- OS 临时目录，用于截图、下载结果和生成文件；
- 用户在配置中显式添加的目录，例如桌面或专用输出目录。

校验顺序：

1. 去掉 Pi 路径参数可能带的前导 `@`。
2. 相对路径按 Agent `cwd` 解析。
3. 使用 `realpath` 得到规范绝对路径。
4. 检查规范路径位于允许根目录内，不能只做字符串前缀判断。
5. 打开文件并 `fstat`，只允许普通文件。
6. 拒绝目录、设备文件、Socket、FIFO 和越界符号链接。
7. 读取前后检查大小，降低检查后替换的风险。

配置中的 Windows 路径需要在 WSL 环境规范化。例如 `C:\Users\...` 应转换为对应 `/mnt/c/Users/...` 后再进入同一校验流程。

### 6.3 大小和内存边界

QQ 官方页面未在当前字段表中给出完整大小上限，因此以下是插件的保守默认值，不代表 QQ 官方上限：

- 每张图片：10 MiB；
- 每个普通文件：20 MiB；
- 每个 Agent 回合总计：30 MiB；
- 每个回合最多成功发送 2 个文件；
- 上传超时：30 秒，正式值根据沙箱实测调整；
- base64 会增加约三分之一内存和请求体积，读取前按原文件字节数限制。

第二阶段如需大文件，应使用 QQ 官方确认可用的分片能力，不能简单提高 base64 硬上限。

### 6.4 类型识别

- 不只信任扩展名，使用 magic bytes 校验 PNG/JPEG。
- 图片 `kind=auto` 时，真实 PNG/JPEG 使用 `file_type: 1`。
- 其他普通文件使用 `file_type: 4`。
- 首轮不把 WebP/GIF/SVG 自动伪装成 JPG/PNG。
- 是否增加安全图片转换应作为独立后续功能，并明确输出格式和质量变化。
- 文件名只用于用户反馈和诊断，去除控制字符并限制长度。

### 6.5 敏感信息

以下内容不能进入普通日志、终端状态、Agent prompt 或最终回复：

- access token；
- `file_data` base64；
- QQ 返回的完整 `file_info`；
- 未脱敏的上传响应；
- 不必要的本地绝对路径。

状态只显示：文件名、类型、大小、阶段、稳定错误码。

## 7. 回复配额与发送时序

当前插件保守限制每个入站消息最多 4 次回复。建议每个回合至少为最终文字保留 1 次：

```text
可能的正常顺序：
1. 慢任务回执（可选，已经发送才计数）
2. 图片或文件 A
3. 图片或文件 B
4. 最终简短文字
```

具体规则：

- `/files` 上传成功后、调用 `/messages` 前才预留一个 `msg_seq`。
- 序号在 await 前原子递增，避免进度回执与工具发送撞号。
- 工具发送时必须为最终文本保留至少一个回复槽位。
- 回复槽位不足时，工具在读取/上传前尽早失败。
- 富媒体消息发送后遇到网络断开属于“结果未知”，不能无条件换新序号重发。
- 上传请求在确认未产生消息时可以做有限重试；消息发送请求不做可能导致重复交付的盲重试。
- 已成功发送媒体但 Assistant 最终文本为空时，不再发送“无文本回复”错误；媒体本身已经完成用户任务。

## 8. 错误语义与用户反馈

建议稳定错误码：

- `outbound_disabled`：出站富媒体未启用；
- `outbound_not_authorized`：当前 QQ 用户无权限；
- `path_invalid`：路径无效；
- `path_outside_allowed_roots`：路径不在允许目录；
- `not_regular_file`：不是普通文件；
- `file_not_found`：文件不存在；
- `file_too_large`：文件超过插件限制；
- `turn_total_limit`：本回合累计大小超限；
- `reply_budget_exhausted`：被动回复配额不足；
- `unsupported_media_type`：媒体类型不支持；
- `media_upload_failed`：QQ `/files` 上传失败；
- `media_send_failed`：QQ `/messages` 明确拒绝；
- `media_send_unknown`：网络中断，无法确认是否已发送；
- `delivery_context_closed`：回合已结束或被停止。

工具成功结果示例：

```text
已通过 QQ 发送图片 photo.png（1.8 MiB）。平台已确认接收。
```

工具失败结果示例：

```text
未发送 report.pdf：文件不在允许发送的目录中（path_outside_allowed_roots）。
```

插件最终回复可附加一条确定性回执：

- `已发送：photo.png`
- `未发送：report.pdf（文件过大）`

该回执来自 DeliveryContext 的真实记录，不从模型文本推断。

## 9. 配置设计

建议配置升级到 `schemaVersion: 3`，新增独立的 `outboundMedia`，避免与现有入站 `media` 混淆：

```json
{
  "outboundMedia": {
    "enabled": false,
    "adminsOnly": true,
    "allowPrivate": true,
    "allowGroups": false,
    "allowedRoots": [],
    "images": true,
    "files": true,
    "voice": false,
    "video": false,
    "maxFilesPerTurn": 2,
    "maxImageBytes": 10485760,
    "maxFileBytes": 20971520,
    "maxTotalBytes": 31457280,
    "uploadTimeoutMs": 30000
  }
}
```

兼容策略：

- v2 配置自动归一化为 v3 内存结构；
- 缺少 `outboundMedia` 时保持禁用；
- 所有数值都有插件硬上限，不能配置为无限；
- `allowedRoots: []` 仅代表内置的 `cwd + temp`，不代表允许整个文件系统；
- 示例配置不写真实用户名、OpenID 或绝对路径。

## 10. 文件级实施计划

### 10.1 `types.ts`

增加：

- `QQOutboundMediaConfig`；
- `QQMediaUploadResult`；
- `QQOutboundDeliveryRecord`；
- 出站终端事件：`outbound_start`、`outbound_uploaded`、`outbound_sent`、`outbound_failed`。

### 10.2 `config.ts`、`config.test.ts`、示例配置

- 增加 v3 默认值和严格归一化；
- 增加 allowed roots 规范化；
- 增加大小、数量和超时 clamp；
- 测试 v2 升级默认禁用、恶意/无效配置和 Windows/WSL 路径配置。

### 10.3 `qq-api.ts`

新增：

```text
uploadMedia(target, fileType, fileData, signal)
sendMedia(target, fileInfo, msgSeq, signal)
```

职责：

- 根据 private/group 选择 `/files` 路径；
- 上传时固定 `srv_send_msg: false`；
- 严格解析 `file_info` 和 `ttl`；
- 根据 private/group 选择 `/messages` 路径；
- 使用 `msg_type: 7`；
- 保留 QQ 状态码和业务错误码，不记录 base64/file_info；
- 支持 AbortSignal 和不低于官方建议的 HTTP 超时。

### 10.4 新增 `outbound-media.ts`

集中负责：

- 本地路径解析和 allowed roots 策略；
- 普通文件校验；
- 图片 magic bytes；
- 大小与回合累计限制；
- base64 编码；
- 上传和发送编排；
- DeliveryContext 生命周期；
- 脱敏结果与错误码。

该模块不解析模型最终文本，也不选择目标 QQ 用户。

### 10.5 `qq-session.ts`

- 使用 Pi SDK `createAgentSessionFromServices({ customTools })` 注入工具；
- 工具只存在于 QQ 隔离 Agent，不加入本地 Pi 会话；
- 工具 closure 只调用当前 DeliveryContext，不持有固定旧 `msg_id`；
- 会话 `/new`、`/resume` 后重新绑定时保持工具可用；
- 工具参数使用严格 schema，低能力模型只需提供路径。

如工具 schema 需要 `typebox`，应把它列为本包直接依赖，不能依赖 Pi 的偶然传递依赖。

### 10.6 `conversation-registry.ts`

- 创建 `QQAgentSession` 时注入出站工具桥接器；
- 不让某个会话持有另一个会话的 target；
- dispose 时关闭活动 DeliveryContext。

### 10.7 `router.ts`

- 每个 `runOne()` 创建并激活 DeliveryContext；
- 复用 `nextMsgSeq`，统一管理文本、进度回执和媒体序号；
- 媒体工具为最终文字预留配额；
- run 完成后输出实际交付摘要；
- `/stop` 中止读取、上传并关闭 Context；
- final reply 根据剩余配额自动缩短为一条；
- fake 模式只模拟并显示计划，不读取或上传真实文件。

### 10.8 `terminal-view.ts`

建议显示：

```text
↑ image  photo.png  1.8 MiB  validating
↑ image  photo.png  uploading
✓ image  photo.png  sent
✗ file   report.pdf  file_too_large
```

不显示完整本地路径、base64、file_info 或 token。

### 10.9 `README.md`

增加：

- 出站富媒体使用方式；
- 与入站附件的区别；
- 管理员权限和 allowed roots；
- 支持格式和大小边界；
- C2C/群聊回复窗口；
- 平台错误排查；
- “平台确认成功”与“发送结果未知”的差异。

## 11. 分阶段执行安排

### 阶段 0：沙箱接口探针

- 用固定小 PNG 和小 TXT 验证 `file_data` 两步流程；
- 确认 `srv_send_msg: false` 不直接发送；
- 验证 private `/files` 返回结构；
- 验证 `msg_type: 7`、`media.file_info`、`msg_id`、`msg_seq`；
- 记录文件名、TTL、大小和错误行为；
- 探针只使用测试文件，不发送用户真实数据。

退出条件：确认无需公网 URL 即可发送本地数据，或拿到明确的平台拒绝证据。

### 阶段 1：API 与本地文件策略

- 实现配置和类型；
- 实现 `uploadMedia` / `sendMedia`；
- 实现安全路径、类型和大小校验；
- 完成纯单元测试，不接入 Agent。

退出条件：给定测试 target 和文件，能够生成正确请求；非法路径在网络请求前拒绝。

### 阶段 2：Agent 专用工具

- 注入 `qq_send_local_file`；
- 增加每回合 DeliveryContext；
- 接入真实 `QQReplyTarget` 和 AbortSignal；
- 验证低能力模型所需的最小 schema 和描述。

退出条件：Agent 必须调用工具才能产生真实媒体发送，目标不可由模型修改。

### 阶段 3：回复预算与可观测性

- 统一 `msg_seq` 分配；
- 处理进度回执、两份媒体和最终文字组合；
- 增加终端事件、状态和实际交付摘要；
- 完善失败与结果未知语义。

退出条件：不会撞序号、超 4 次或在下一条消息中错投。

### 阶段 4：真实 QQ 验收与文档

- 沙箱私聊验收；
- 正式环境小文件验收；
- 更新 README 和示例配置；
- 检查发布包不含测试文件、真实配置、base64、token 或 OpenID；
- 版本发布、提交、推送另行执行，不包含在本计划确认动作中。

## 12. 测试矩阵

### 12.1 路径与权限

- 相对路径位于 cwd：允许；
- OS 临时目录截图：允许；
- 显式 allowed root 中的桌面文件：允许；
- `../` 越界：拒绝；
- 符号链接跳出 allowed root：拒绝；
- 目录、FIFO、设备文件：拒绝；
- 未授权 QQ 用户：读取前拒绝；
- 群聊默认：拒绝；
- Windows 路径在 WSL 中正确规范化。

### 12.2 类型与大小

- PNG magic + `.png`：图片；
- JPEG magic + `.jpg/.jpeg`：图片；
- 伪装成 PNG 的文本：拒绝图片类型；
- PDF/TXT/ZIP：普通文件；
- 空文件：按 QQ 实测结果决定允许或明确拒绝；
- 单文件超限：读取/编码前拒绝；
- 多文件累计超限：后续文件拒绝；
- base64 和 `file_info` 不出现在日志。

### 12.3 QQ API

- private/group 上传路径正确；
- `file_type` 映射正确；
- `srv_send_msg=false`；
- 缺少 `file_info`：失败；
- 401：认证错误；
- 429/22009：频控错误；
- 304082/304083：媒体上传/转换错误；
- Abort：停止且不继续消息发送；
- 网络断开发生在消息发送阶段：结果标记 unknown，不盲重试。

### 12.4 回复预算

- 无 ack + 1 媒体 + 1 文本；
- 有 ack + 2 媒体 + 1 文本，共 4 次；
- 第 3 个媒体因预留最终文字而拒绝；
- Markdown 失败回退可能额外消耗序号时仍不超限；
- 媒体已成功但 final text 为空，不发送错误占位；
- `/stop` 后旧工具不能使用下一条消息 target。

### 12.5 Agent 行为

- “把 `/tmp/a.png` 发给我”：调用工具；
- “告诉我 `/tmp/a.png` 在哪里”：不调用工具；
- “搜索图片并发给我”：先产生本地文件，再调用工具；
- “发到另一个 OpenID”：模型不能控制目标；
- 工具失败：Assistant 不得说已发送；
- 工具成功：最终回复简短，实际交付摘要与记录一致；
- 选择至少一个较弱模型和一个较强模型做相同指令对比。

## 13. 验收标准

- [ ] 手机 QQ 收到真实 PNG/JPG 图片消息，而不是 URL 或本地路径。
- [ ] 手机 QQ 收到真实普通文件消息。
- [ ] 只有显式授权用户可以触发本地文件外传。
- [ ] 模型不能指定或篡改发送目标。
- [ ] 文件必须位于允许根目录并通过普通文件、类型和大小校验。
- [ ] QQ API 成功前不会返回“已发送”。
- [ ] 上传失败时不会退化成 URL 并伪装成功。
- [ ] 文本、进度回执和媒体共享同一 `msg_seq` 预算且不超过 4 次。
- [ ] `/stop`、超时、会话切换和 runtime 替换不会造成迟到发送或错投。
- [ ] base64、token、file_info 和敏感绝对路径不进入普通日志。
- [ ] 强模型和弱模型都能通过同一工具完成基本图片发送。
- [ ] 现有 QQ 入站附件、文本回复、命令、会话隔离和本地 TUI 行为无回归。

## 14. 风险与控制

- **平台文档字段歧义**：先用测试文件做沙箱探针，确认 `file_data` 后再接入真实文件。
- **本地文件泄露**：默认关闭、管理员限定、allowed roots、普通文件检查和硬大小限制。
- **模型误调用**：工具目标固定为当前会话；配置要求显式发送意图；最终由插件记录真实交付。
- **回复超频**：媒体发送纳入现有 4 次预算，并始终预留最终文字槽位。
- **重复发送**：消息发送阶段不做盲重试；网络不确定时明确标记 unknown。
- **内存峰值**：P0 使用较小硬上限；大文件后续走官方确认的分片方案。
- **会话错投**：每回合独立 DeliveryContext + run token + finally 关闭。
- **弱模型不用工具**：工具 schema 保持最小，描述写明触发条件，并用真实弱模型验收；不使用隐式路径正则自动发送作为捷径。

## 15. 实施前确认项

建议按以下默认决策进入编码：

1. 第一阶段先支持私聊 PNG/JPG 和普通文件。
2. 本地文件优先走 `file_data`，不建立公网 URL 服务。
3. 新功能升级后默认关闭，只对显式管理员启用。
4. 默认允许目录为 Agent cwd 和 OS temp；桌面等目录由配置显式加入。
5. 每回合最多发送 2 个文件，并为最终文字保留回复配额。
6. 语音、视频、群聊和大文件分片放到第二阶段。
7. 只有 QQ API 明确成功时工具才返回“已发送”。
8. 当前工作区已有未提交修改，实施时在其基础上增量修改，不覆盖或回退。

确认本计划后，下一步应先执行“阶段 0：QQ 沙箱接口探针”，再根据真实响应进入功能编码。
