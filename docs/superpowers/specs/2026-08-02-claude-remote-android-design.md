# Claude Remote Android 设计规格

日期：2026-08-02

## 1. 背景

用户希望在 Android 手机上获得接近本机 Claude Code 的对话体验，包括查看会话、继续旧会话、新建会话、接收流式回复，以及批准或拒绝工具调用。

该方案不得使用 Claude 官方 Remote Control 服务。手机通过 Cloudflare Tunnel 访问用户 Mac 上的自托管桥接服务，Claude 模型请求仍由 Mac 上现有的 Claude Code 配置发往当前 API 服务。

## 2. 目标

首版必须支持：

- 仅供单个用户本人的一台已配对 Android 设备使用。
- Android 原生对话界面。
- 使用 Mac 当前配置的默认模型新建 Claude Code 会话。
- 查看 Bridge 管理的会话，并从已授权项目导入本机已有会话。
- 按 session ID 在原项目目录恢复旧会话。
- 实时显示 Claude 回复、状态和工具调用。
- 当 Claude Code 发出权限提示时，在手机上允许一次或拒绝。
- 对用户消息提供幂等提交，避免断线重试造成重复输入。
- 手机断线后重连并补齐所有未确认事件。
- Mac Bridge 重启后清理旧进程状态，并通过 session ID 恢复会话。
- 通过 Cloudflare Tunnel 从公网安全访问。
- 通过 Cloudflare Access Managed OAuth 和设备密钥进行双层认证。

## 3. 非目标

首版不支持：

- 直接附着到已经在普通终端中运行的 Claude Code 进程。
- 检测或阻止普通终端绕过 Bridge 恢复同一 session。
- 同一 session 在手机和终端中同时输入。
- 强制每个 Claude Code 工具调用都弹出手机确认；Bridge 只转发 Claude Code 按固定安全模式和本机规则产生的权限提示。
- 任意远程 Shell、通用文件浏览或文件下载。
- 图片及文件上传。
- App 退到后台后的云推送通知。
- 多用户、同时保留多台已配对设备、公开注册、租户隔离或配额管理。
- 在手机端选择任意模型或权限模式。
- 把项目目录白名单当作操作系统级文件沙箱。
- 复制 Claude 官方 App 的品牌资源或界面。
- 使用不稳定的 PTY 文本解析作为主要控制协议。

## 4. 技术约束与兼容性门槛

Claude Code 没有面向第三方的接口，可附着到任意已运行的交互式终端进程。自托管方案采用以下受支持能力：

- `claude -p`
- `--input-format stream-json`
- `--output-format stream-json`
- `--include-partial-messages`
- `--permission-prompt-tool`
- `--session-id <uuid>`
- `--resume <session-id>`
- `--permission-mode default`

Bridge 必须拥有它控制的 Claude Code 子进程。旧会话通过新的子进程按 session ID 恢复，而不是接管旧进程。

首版开发基线固定为本机已验证的 Claude Code `2.1.133`。公开文档确认 `--permission-prompt-tool` 会调用 MCP 工具，但没有公开其完整 JSON 契约。本机版本验证得到：

- MCP 工具输入为 `tool_name`、`input` 和可选 `tool_use_id`。
- MCP 工具结果必须是单个文本内容块。
- 文本内容是 `allow` 或 `deny` 决定的 JSON。

该契约被视为版本兼容适配器，而不是长期稳定 API。实施的第一个门槛是运行无副作用的权限探测测试，确认当前 Claude Code 版本仍接受该输入和返回格式。探测失败时停止实施，不猜测协议；重新评估 Claude Agent SDK 或其他受支持接口。

`system/init` 事件中的 `session_id` 是本次进程的权威标识。新会话由 Bridge 生成 UUID 并传给 `--session-id`，随后必须校验初始化事件返回同一 ID。

`~/.claude/projects/` 只作为历史记录和历史快照来源，不作为实时控制协议。Bridge 不修改其中的文件，并将格式解析隔离在可版本化、可失败的兼容适配器中。

Android 首版最低支持 Android 9（API 28）。设备必须能在 Android Keystore 中生成不可导出的 ECDSA P-256 密钥，并完成 `SHA256withECDSA` 签名。StrongBox 是可选增强，不作为要求。首次启动执行能力探测；若密钥生成、不可导出保证或签名验证失败，则阻止配对并显示设备不受支持，不降级为 APK 内置密钥或可导出的软件私钥。

实施 Phase 0 包含三个独立门槛：

1. Claude Code：权限 MCP 契约、session ID 和跨 resume 的用户消息 UUID 去重。
2. Cloudflare：Managed OAuth、Access bearer HTTP 请求和 bearer WebSocket Upgrade。
3. Transcript：目标 Claude Code 版本的只读历史快照转换。

任一门槛失败都停止对应实现并回到架构决策，不把不兼容留到最终验收。

## 5. 总体架构

```text
Android App
    │  Managed OAuth + PKCE
    │  HTTPS / WebSocket
    ▼
Cloudflare Access + Tunnel
    │  Cf-Access-Jwt-Assertion
    ▼
Mac Bridge Service (127.0.0.1 only)
    ├── Auth and Pairing
    ├── Command Ledger and Event Journal
    ├── Session Supervisor
    ├── Permission Broker ◄──── Unix socket ──── Permission MCP Adapter
    └── Session Importer                              ▲
             │                                        │ stdio MCP
             │ stream-json stdin/stdout                │
             ▼                                        │
        Claude Code CLI child process ────────────────┘
             │
             ├── project files
             ├── user/project settings
             ├── MCP servers and hooks
             └── Claude session transcripts
```

项目采用独立仓库，包含两个主要程序：

- `android/`：Kotlin + Jetpack Compose Android App。
- `bridge/`：TypeScript + Node.js Mac 后台服务，包含一个供 Claude Code 启动的轻量 Permission MCP Adapter 入口。

Bridge 由 macOS `launchd` 自动启动。Cloudflare Tunnel 将单一公网主机名转发到 Bridge 的本地端口。Bridge 不监听局域网或公网网卡。

## 6. 组件边界与数据所有权

### 6.1 Android App

职责：

- 通过 Cloudflare Access Managed OAuth 的 Authorization Code + PKCE 完成用户登录。
- 设备首次配对，并在 Android Keystore 中保存不可导出的 ECDSA P-256 私钥。
- 保存 OAuth refresh token 和 Bridge 设备会话令牌的加密副本。
- 使用 Room 持久化标准化的会话历史投影、消息发送状态和最后确认事件位置。
- 显示连接状态和 Bridge 状态。
- 浏览会话列表。
- 新建、恢复、停止和释放会话。
- 以客户端生成的幂等键发送用户消息和控制命令。
- 渲染流式回复和结构化工具事件。
- 展示权限请求并提交允许一次或拒绝。
- 确认已消费事件，并在断线后从最后确认位置恢复。

Android App 不保存 Claude API key，不直接调用 Claude API，也不能提交任意本机路径或 Shell 命令。

### 6.2 Mac Bridge

职责：

- 验证 Cloudflare Access 身份断言。
- 设备配对、挑战签名、短期设备会话和设备撤销。
- 授权项目目录管理。
- 会话索引、Bridge 范围的单写入者锁和命令幂等账本。
- Claude Code 子进程生命周期管理。
- stream-json 与 App 协议转换。
- 权限请求和用户决定的往返传递。
- 持久化未确认事件并在重连时补发。
- 生成经过脱敏的安全审计记录。

Bridge 对外只提供定义明确的会话操作，不提供通用命令执行接口。

### 6.3 Session Supervisor

每个活动 session 对应一个受 Supervisor 管理的 Claude Code 子进程。Supervisor 负责：

- 构造固定安全参数，包括 `--permission-mode default` 和 Bridge 管理的 MCP 配置。
- 为新会话传入 `--session-id`，并校验 `system/init.session_id`。
- 为恢复会话在已绑定的规范项目目录中传入 `--resume`。
- 连接 stdin、stdout 和 stderr。
- 解析流式事件并进行版本适配。
- 跟踪进程组、进程启动时间、Bridge 实例租约和退出原因。
- 在停止、释放、超时或异常时按确定的信号顺序回收进程。

### 6.4 Permission Broker 与 MCP Adapter

Permission MCP Adapter 是 Claude Code 通过 `--mcp-config` 启动的 stdio MCP 服务。CLI 使用 `--permission-prompt-tool mcp__claude_remote_permission__decide` 指定其唯一工具。

在 Claude Code `2.1.133` 的兼容适配器中，工具输入为：

- `tool_name: string`
- `input: object`
- `tool_use_id?: string`

Adapter 生成 Bridge 内部 `permissionRequestId`，通过权限为 `0600` 的 Unix domain socket 将请求交给 Permission Broker。每个 Claude 子进程获得一个 256 位单次租约秘密，Adapter 连接时必须证明该秘密并绑定 session ID；秘密只通过子进程环境传递且不写入日志。Broker 将请求写入事件日志，并最多等待五分钟由当前写入设备决定。

Adapter 返回一个 MCP 文本内容块，其文本为以下 JSON 之一；只有原请求包含 `tool_use_id` 时才加入 `toolUseID`：

- 允许：`{"behavior":"allow","updatedInput":<原始 input>,"toolUseID":<可选原 tool_use_id>}`
- 拒绝：`{"behavior":"deny","message":<用户拒绝或超时原因>,"interrupt":false,"toolUseID":<可选原 tool_use_id>}`

首版永不返回 `updatedPermissions`，因此手机不能创建永久权限规则。MCP 连接失败、Bridge 租约失效、请求超时或 session 被停止时一律返回拒绝；无法返回时终止 Claude 子进程，保持失败关闭。

该字段结构来自固定版本的本机兼容性验证，不作为公开 API 保证。启动时兼容性探测和真实 CLI 集成测试必须覆盖它。

### 6.5 SQLite 数据

Bridge 使用 SQLite 保存以下逻辑表：

- `projects`：项目 ID、规范 realpath、设备号、inode 和显示名称。
- `sessions`：权威 session ID、项目 ID、显示名称、状态、最后活动时间、来源、最后 Claude Code 版本和持久化 `lastEventId` 高水位。
- `commands`：request ID、idempotency key、规范 payload hash、设备 ID、session ID、命令类型、状态和结果引用。
- `pending_events`：尚未被 Android 确认的完整事件载荷，主键包含 session ID 和事件 ID。
- `device_delivery`：唯一设备在每个 session 的确认位置、checkpoint watermark 和协议版本。
- `history_snapshots` 与 `history_snapshot_items`：十分钟有效的不可变重同步检查点、`prepared`/`committed` 状态和物化历史分页。
- `session_locks`：session ID、Bridge instance ID、子进程租约和心跳。
- `devices`：设备 ID、公钥、Access subject、配对和撤销时间。
- `device_sessions`：设备会话令牌哈希、到期时间和撤销状态。
- `pairing_tokens`：配对令牌哈希、到期时间和单次使用状态。
- `auth_challenges`：短期 `challengeRaw`、device ID、Access subject、hostAscii、到期时间和单次使用状态。

完整 Claude 对话仍以 Claude transcript 为权威来源。Bridge 只为交付保证暂存未确认事件；Android 确认后延迟十分钟删除。Claude API key、MCP 凭据和 OAuth 明文 refresh token 不进入 SQLite。

### 6.6 Session Importer

导入只在用户对某个已授权项目执行“扫描旧会话”时发生：

1. Bridge 重新验证项目 realpath、设备号和 inode。
2. Importer 只读扫描该项目对应的 Claude transcript 目录。
3. 文件名必须是有效 UUID；重复 session ID 直接合并。
4. 解析器只提取 session ID、时间和可选标题。损坏文件显示为不可导入，不中断其他结果。
5. 用户确认后，session 与该项目 ID 永久绑定。

手动导入也必须先选择授权项目，且 Bridge 必须确认该 session transcript 存在于该项目对应目录。项目移动、重命名或 inode 改变后不自动重绑；用户需在 Mac 本地重新授权并重新扫描。

### 6.7 History Adapter 与一致性检查点

查看或恢复旧会话必须能够显示既有对话。History Adapter 只读解析绑定项目的 Claude transcript，并输出稳定的 App history schema：

- `historyItemId`：来自 transcript 消息 UUID，缺失时由文件偏移和内容哈希生成。
- `role`：user、assistant、tool 或 system。
- `contentBlocks`：文本和结构化工具摘要。
- `createdAt`
- `sourceTranscriptOffset`

`session.snapshot.begin` 创建一个状态为 `prepared` 的不可变重同步检查点：

1. Bridge 取得 session resync mutex。该锁暂时阻止 event ID 分配、命令状态变化、session 状态变化和权限状态变化；新收到的 Claude stdout 事件只进入内存缓冲。
2. Bridge 记录 transcript 当前字节长度，只读取该长度以内、最后一个完整换行符之前的 JSONL。尾部未完成记录不进入本次快照。
3. History Adapter 把这些完整记录物化为不可变 snapshot items，而不是在后续分页时重新读取活动 transcript。
4. Bridge 在一个 SQLite 事务中创建 `snapshotId`，保存 adapter 版本、读取字节边界、`historyRevision`、当前设备的服务端 delivery position 作为 `deliveryBase`、当前 `lastEventId` 作为 `deliveryWatermark`、当前 session 状态、全部非终态命令状态，以及当前未决权限请求和剩余超时。
5. 创建 `prepared` 快照时不前移服务端 delivery position，不标记或删除任何未确认事件。该 device/session 存在 `prepared` 快照期间，普通 `events.ack` 不得前移超过 `deliveryBase`；Bridge 对此返回 `409 CHECKPOINT_COMMIT_REQUIRED`。
6. Bridge 释放 resync mutex，再为缓冲事件分配大于 watermark 的 event ID。

`historyRevision` 是 adapter 版本、transcript 规范路径、读取字节边界和完整读取字节的 SHA-256。`session.snapshot.page` 只从已物化的 snapshot items 分页，cursor 是绑定 `snapshotId` 的不透明随机值。未提交检查点创建后十分钟固定过期；过期 cursor 或提交请求返回 `410 SNAPSHOT_EXPIRED`，Android 必须重新调用 `session.snapshot.begin`。快照过期不会改变 delivery position，也不会使未确认事件失效。

检查点首个响应原子包含：

- `snapshotId`
- `historyRevision`
- 第一页 history items 和 `nextCursor`
- `deliveryBase`
- `deliveryWatermark`
- 当前 session 状态
- 全部非终态命令及其状态
- 当前未决权限请求及剩余超时

Android 获取全部分页期间缓冲该 session 中 `eventId > deliveryWatermark` 的实时事件，不应用旧的未确认尾部。分页完成后，Android 预先生成稳定 commit idempotency key，并在同一个 Room 事务中：替换该 revision 的历史投影、命令状态、session 状态和 pending permission；把本地投影位置设为 `deliveryWatermark`；写入 `checkpoint_commit_pending`，保存 `snapshotId`、`historyRevision`、`deliveryBase`、`deliveryWatermark` 和该 idempotency key。pending 记录存在期间，Android 禁止发送超过 `deliveryBase` 的普通 `events.ack`，也不得开始正常事件消费。

只有该 Room 事务成功后，Android 才使用 pending 记录中的原 idempotency key 调用 `session.snapshot.commit`，携带 `snapshotId`、`historyRevision` 和 `deliveryWatermark`。App 若在调用前或等待响应时退出，重启后必须先重试同一 commit，不能根据本地 projection watermark 发送普通 ACK。

Bridge 原子验证快照仍处于 `prepared`、属于当前 device/session 且三个提交字段完全匹配，然后把快照改为 `committed`、将该设备的 delivery position 前移到 watermark，并标记 `eventId <= deliveryWatermark` 的事件被该检查点取代。重复提交以原 idempotency key 返回同一成功结果；响应丢失不会产生第二次状态变化。Android 收到成功结果后在 Room 中清除 pending 记录，再按 event ID 顺序应用已缓冲的更大事件；若此时崩溃，这些事件仍未被服务端确认并会重新补发。

提交前断线或 Room 事务失败时，所有未确认事件仍可补发。若 commit 返回 `410 SNAPSHOT_EXPIRED`，Android 把该 snapshot projection 标记为无效但保留 pending 中的 `deliveryBase` 作为 ACK 上限，不确认 `deliveryWatermark`，并从新的 `session.snapshot.begin` 重建；新快照成功提交后才替换并清除旧 pending 状态。

快照项和实时事件共享 message UUID/tool use ID，Android 以稳定来源 ID upsert，因此 transcript 已包含某个缓冲事件时也不会重复显示。

Android Room 是该 App 安装上已渲染历史的持久化所有者；Claude transcript 是跨安装、导入和重新同步时的权威重建来源。transcript 解析失败时，App 明确显示“历史不可读取”，允许用户选择仅从当前恢复点继续，但不得显示不完整历史为完整记录。

## 7. 会话生命周期与状态机

### 7.1 状态

Bridge session 使用以下互斥状态：

- `inactive`：没有子进程，可恢复。
- `starting`：正在启动并等待 `system/init`。
- `idle`：子进程可接收用户消息。
- `running`：Claude 正在生成或执行工具。
- `waiting_permission`：Permission Broker 正等待手机决定。
- `interrupting`：正在停止当前进程。
- `releasing`：正在干净关闭并释放 Bridge 锁。
- `interrupted`：进程已停止，会话可重新恢复。
- `failed`：发生需要用户确认的错误。

只有 `idle` 状态接受新的用户消息。每次状态变化均持久化并生成事件。

### 7.2 新建会话

1. Android 请求授权项目列表。
2. 用户选择项目并输入可选会话名称；模型使用 Mac 当前默认配置，权限模式固定为 `default`。
3. Bridge 重新验证项目 realpath、设备号和 inode。
4. Bridge 生成 UUID session ID，并在同一事务中创建 session、写入锁和启动租约。
5. Session Supervisor 在该项目目录启动 Claude Code，传入 `--session-id <uuid>`。
6. 收到 `system/init` 后，Bridge 校验返回的 `session_id` 与生成值一致；不一致则终止进程并标记失败。
7. 校验成功后进入 `idle`，Android 开始订阅事件。

### 7.3 恢复会话

1. Android 选择已绑定项目的历史 session。
2. Bridge 验证 transcript 与绑定项目匹配，并重新验证项目身份。
3. Bridge 获取 Bridge 范围的 session 写入锁。
4. 若同一 Bridge 实例已拥有健康子进程，则复用该进程。
5. 否则在绑定项目目录以 `--resume <session-id>` 启动新进程。
6. `system/init.session_id` 必须与目标 session ID 一致，否则恢复失败。

Bridge 不允许客户端把任意 session ID 与任意项目组合，也不尝试附着到普通终端中的现有进程。

### 7.4 用户消息与崩溃窗口

命令状态为 `accepted`、`dispatching`、`dispatched`、`completed`、`failed`、`interrupted` 或 `indeterminate`。其中 `completed`、`failed` 和 `interrupted` 是终态。

1. Android 为每条消息生成稳定的 `requestId` 和 `idempotencyKey`。
2. Bridge 使用 RFC 8785 JSON Canonicalization Scheme（JCS）规范化 payload，以 SHA-256 保存 payload hash，并在 SQLite 事务中插入 `accepted` 命令。
3. 派发前，Bridge 原子把命令改为 `dispatching`，再把使用同一 `requestId` 作为用户消息 UUID 的 stream-json 消息写入 Claude stdin。
4. stdin 写入成功后标记 `dispatched`；收到可确定结果后标记 `completed` 或 `failed`。

任何在初始命令响应之后发生的状态变化，都必须在同一 SQLite 事务中更新 `commands` 并写入持久化 `command.status.changed` 事件；事件以 `requestId` 关联原命令，Android 不通过推测或轮询 transcript 判断状态。

Bridge 或子进程异常结束时，恢复检查必须处理全部非终态命令：

- `accepted` 保持可取消、可再次派发。
- `dispatching` 先转为 `indeterminate`。
- `dispatched` 先转为 `indeterminate`，不能永久停留在非终态。

History Adapter 随后按用户消息 UUID 检查 transcript：

- UUID 不存在：保持 `indeterminate`，表示可能未送达。
- UUID 存在且能找到该 turn 的完整终止结果：转为 `completed` 或 `failed`。
- UUID 存在但 turn 没有完整终止结果：转为 `interrupted`，表示消息已送达但执行被中断。
- transcript 不可解析：保持 `indeterminate`，不猜测结果。

Phase 0 必须验证：同一 session 在进程重启并 `--resume` 后，重新发送相同用户消息 UUID 不会在 transcript 中产生第二条用户消息。只有该测试通过，App 才对“UUID 不存在或 transcript 不可判断”的 `indeterminate` 命令显示“安全重试”。用户触发 `command.retry_indeterminate` 后，Bridge 以原 UUID 和原 payload 重新派发。

`interrupted` 命令不显示重发原消息；App 提供“恢复会话”以及发送一条新的“继续”消息入口。Bridge 不自动重放 `indeterminate` 或 `interrupted` 命令。若 UUID 去重兼容门槛失败，首版的可靠消息要求不成立，实施停止并重新评估接口。

### 7.5 停止、释放与取消

- **停止（Stop）**：终止当前 Claude 子进程和当前 turn，但保留 session 记录，最终状态为 `interrupted`，可再次恢复。
- **释放（Release）**：只允许在 `idle` 或 `interrupted` 状态执行。Bridge 关闭 stdin，等待子进程正常退出并确认 transcript 文件停止变化，然后释放 Bridge 锁，状态变为 `inactive`。
- **取消未派发命令**：仅对 `accepted` 且尚未 `dispatched` 的命令有效；已派发消息不能从对话历史中撤回，只能停止进程。

停止顺序：

1. 未决权限请求先以拒绝解决。
2. 向 Claude 进程组发送 `SIGINT`。
3. 最多等待五秒。
4. 未退出则发送 `SIGTERM`，再等待五秒。
5. 仍未退出才发送 `SIGKILL`。
6. 进程退出且 transcript 文件状态稳定后释放进程租约。

### 7.6 Bridge 崩溃与重启

每个子进程由一个租约包装器监视 Bridge 控制管道。Bridge 退出导致管道关闭时，包装器按停止顺序终止 Claude 进程组，避免孤儿进程继续写 transcript。

Bridge 启动时执行恢复检查：

1. 使上一个 Bridge instance ID 的锁过期。
2. 检查持久化 PID、进程启动时间和租约包装器状态。
3. 仍存在且身份匹配的旧进程先被终止；身份不匹配的 PID 不执行信号操作。
4. 所有旧的未决权限请求标记为拒绝。
5. `running`、`waiting_permission` 或 `interrupting` 会话转为 `interrupted`。
6. 所有 `dispatching` 和 `dispatched` 命令先转为 `indeterminate`，再用 transcript UUID 证据归类为 `completed`、`failed`、`interrupted` 或继续保持 `indeterminate`。
7. 用户显式选择后才按 session ID 恢复，不自动产生新模型请求。

### 7.7 手机与桌面切换

从手机切回终端：

1. 用户在 App 中停止活动 turn，并释放会话。
2. App 显示可复制的 `claude --resume <session-id>` 命令。
3. 用户在 Mac 终端恢复会话。

从终端切回手机：

1. 用户先退出终端中的该 Claude Code 会话。
2. 用户在 App 中选择恢复。
3. Bridge 取得自己的写入锁并启动恢复进程。

Bridge 锁只能排斥其他 Bridge 客户端和 Bridge 子进程，无法检测普通终端直接执行 `claude --resume`。App 必须明确警告用户不要同时在终端和手机写入同一 session；验收中的“第二写入者”仅指通过 Bridge 发起的竞争写入。

## 8. App–Bridge 协议

### 8.1 版本协商

HTTP API 固定在 `/api/v1/`。WebSocket 客户端使用 `Sec-WebSocket-Protocol: claude-remote.v1`，服务端必须明确选择该子协议，否则拒绝升级。

`GET /api/v1/capabilities` 返回：

- `protocolVersion`
- `minimumAndroidVersion`
- `bridgeVersion`
- `claudeCodeVersion`
- `features`
- `serverTime`

不兼容时 HTTP 返回 `426 Upgrade Required`。已建立连接使用以下应用关闭码：

- `4401`：Access 或设备认证失效。
- `4403`：设备或项目未授权。
- `4409`：session 写入冲突。
- `4410`：客户端状态需要重新同步。
- `4426`：协议版本不兼容。
- `4500`：Bridge 内部错误。

待补发事件与生成它们的协议版本绑定。Bridge 升级若无法转换旧事件，返回 `4410`。Android 保留本地发送状态用于提示，但丢弃该 session 的未确认渲染尾部，完成 `session.snapshot.begin/page` 和本地 Room 事务后调用 `session.snapshot.commit`；只有 commit 成功才由服务端前移 delivery position 并取代 `deliveryWatermark` 以内的旧事件。Android 随后重连并应用更大 event ID，因此已提交检查点不会重复触发同一 `4410`，未提交或失败的检查点也不会丢失旧事件。

### 8.2 客户端命令

所有命令使用统一 envelope：

- `protocolVersion`
- `requestId`：客户端生成 UUID。
- `idempotencyKey`：同一逻辑操作重试时保持不变。
- `commandType`
- `sessionId`：全局命令可为空。
- `sentAt`
- `payload`

首版命令类型：

- `session.list`
- `session.scan_imports`
- `session.import`
- `session.create`
- `session.resume`
- `session.stop`
- `session.release`
- `session.state.get`
- `session.snapshot.begin`
- `session.snapshot.page`
- `session.snapshot.commit`
- `message.send`
- `command.cancel`
- `command.retry_indeterminate`
- `permission.resolve`
- `events.ack`

Bridge 在执行业务操作前分别强制 `requestId` 唯一，以及 `(deviceId, idempotencyKey)` 组合唯一，并保存规范化 payload hash。重复键且 payload 相同则返回已保存状态或结果；重复键但 payload 不同则返回冲突，绝不执行第二次。

### 8.3 命令响应

响应包含：

- `protocolVersion`
- `requestId`
- `responseType`：`command.status` 或 `command.error`。
- `commandStatus`：适用时为 `accepted`、`dispatching`、`dispatched`、`indeterminate`、`interrupted`、`completed` 或 `failed`。
- `result` 或结构化 `error`

结构化错误至少包含稳定的 `code`、面向用户的 `message` 和可选 `retryable`。WebSocket 断开前未收到响应时，Android 使用原 idempotency key 重试并取得原命令状态。

若初始响应返回非终态，后续每次状态变化通过持久化的 `command.status.changed` 事件交付。其 payload 至少包含 `requestId`、`idempotencyKey`、`commandType`、新 `commandStatus`，以及终态时的 `result` 或结构化 `error`。命令表更新和该事件插入必须处于同一 SQLite 事务；因此断线重连、Bridge 重启和事件补发使用与其他 session 事件相同的 ACK 保证。初始响应已是终态的同步协议操作无需再生成状态事件。

### 8.4 服务端事件

所有服务端事件包含：

- `protocolVersion`
- `eventId`：Bridge 生成的单调递增无符号 64 位编号，作用域为 session，并在 JSON 中编码为十进制字符串，避免 JavaScript/Kotlin JSON 数值精度差异。
- `sessionId`
- `eventType`
- `timestamp`
- `payload`

核心事件类型：

- `session.state.changed`
- `command.status.changed`
- `assistant.message.delta`
- `assistant.message.completed`
- `tool.started`
- `tool.output.delta`
- `tool.completed`
- `permission.requested`
- `permission.resolved`
- `process.stderr.summary`
- `session.interrupted`
- `session.failed`

Bridge 只做 Claude Code stream-json 与 App 协议之间的转换，Android 不依赖 Claude Code 的原始事件格式。

### 8.5 事件交付保证

Bridge 在一个 SQLite 事务中递增 `sessions.lastEventId`，使用新值插入完整 `pending_events`，提交成功后才发送事件。删除已确认事件不改变高水位，因此 Bridge 重启后仍能继续分配严格递增 ID。Android 按 session 保存最后连续消费的 `eventId`，并通过 `events.ack` 确认。

- 未确认事件跨网络断线和 Bridge 重启持久保存。
- Android ACK 的事件，或已成功 `session.snapshot.commit` 后被检查点取代的事件，延迟十分钟删除；`prepared`、失败或过期的快照不能触发删除。
- Android 按 `eventId` 去重并拒绝跳号 ACK。
- Bridge 不按时间丢弃未确认事件。
- 为控制磁盘占用，单个工具输出事件有明确大小上限；超过上限时 Bridge 保存带原始字节数和截断标记的事件，而不是无提示丢失。
- 全局未确认事件达到配置的磁盘上限时，Bridge 不接受新的用户消息，并显示存储压力错误；已运行的 turn 仍按截断规则记录到终态。

因此，“不丢失”指不丢失 Bridge 定义并持久化的协议事件；被明确截断的大型原始工具输出不在保证范围内。SQLite 损坏属于不可恢复错误，必须明确报告，不伪造连续事件流。

## 9. 工具权限

Bridge 使用固定的 `--permission-mode default` 和 Permission MCP Adapter。服务端拒绝客户端请求 `acceptEdits`、`auto`、`bypassPermissions` 或 `dontAsk`。

`default` 模式和本机已有 permission rules 可能允许部分工具而不产生提示。首版不承诺“每个工具都询问”，只保证 Claude Code 实际发出的权限请求均通过手机处理。App 本身不提供新增永久 allow rule 的能力。

权限请求事件包含：

- `permissionRequestId`
- `toolName`
- 原始结构化 `input`
- 可选 `toolUseId`
- 请求时间和超时时间
- 基于工具名称的静态展示类别：只读、文件变更、命令执行、网络或其他

界面只在能够确定时提取辅助字段，例如 Bash 的 `command` 或文件工具的 `file_path`；始终允许查看完整原始 JSON。首版不生成主观“风险分数”，也不承诺执行前存在文件修改摘要。

用户决定只有：

- 允许一次：返回原始 `input`，不保存权限规则。
- 拒绝：返回用户拒绝消息，不中断整个会话。

`permission.resolve` 必须携带原 `permissionRequestId`、session ID 和 idempotency key。来自错误设备、错误 session、已解决请求或过期请求的决定被拒绝。超时、断线超时、MCP 失败和 session 停止均失败关闭为拒绝。

## 10. 公网安全

### 10.1 网络边界

- Bridge 仅绑定 `127.0.0.1`。
- Cloudflare Tunnel 是唯一公网入口。
- 不配置路由器端口转发。
- Tunnel ingress 只映射所需 HTTP 主机名，不使用通用 TCP 转发。
- Tunnel 停止后，Bridge 不应从局域网或公网直接访问。

### 10.2 Cloudflare Access Managed OAuth

Cloudflare Access 应用策略只允许用户指定的唯一身份。Android 使用 Managed OAuth 的 Authorization Code + PKCE（S256）流程，而不是尝试复制浏览器的 `CF_Authorization` cookie。

登录流程：

1. App 从 `https://<host>/.well-known/oauth-authorization-server` 发现 OAuth 元数据。
2. App 作为无 client secret 的 public client 动态注册，并保存 `client_id`。
3. App 使用 Auth Tab 或 Custom Tab 打开登录页，携带 `state`、PKCE challenge、redirect URI 和目标 resource。
4. Cloudflare 通过经过验证的 HTTPS Android App Link 返回 authorization code。
5. App 校验 `state`，用 PKCE verifier 换取 opaque access token 和 refresh token。
6. Refresh token 使用 Android Keystore 保护的密钥加密保存。

HTTP 请求和 WebSocket Upgrade 均使用 `Authorization: Bearer <access_token>`。不把 Cloudflare service token 嵌入 APK。

Cloudflare 在 origin 请求中提供 `Cf-Access-Jwt-Assertion`。Bridge 验证签名、issuer、audience、subject 和到期时间，并要求 subject 与配对设备记录一致。配对、挑战和全部 API 路由都位于 Access 保护之后。

Access token 即将到期时，App 先 refresh 再建立新 WebSocket。Bridge 将每个 socket 的最长寿命限制为 Access assertion 和设备会话两者较早的到期时间，到期主动以 `4401` 关闭；App refresh 后重连。这样不依赖 Cloudflare 是否会主动关闭已建立的 WebSocket。

### 10.3 设备配对、密钥编码和签名协议

配对流程：

1. Mac 本地命令生成 256 位随机配对令牌，二维码包含 Bridge URL、令牌和五分钟到期时间。
2. Bridge 只保存配对令牌哈希；令牌单次使用。
3. Android Keystore 生成不可导出的 `secp256r1` ECDSA 密钥对。
4. Android 用 X.509 SubjectPublicKeyInfo（SPKI）DER 编码公钥，并以无 padding 的 base64url 传输为 `publicKeySpki`。
5. `deviceId = base64url_no_pad(SHA-256(spki_der_bytes))`。
6. 已通过 Access 的 Android 提交配对令牌、`publicKeySpki`、`deviceId` 和设备名称。
7. Bridge 解码并解析 SPKI，验证算法为 `id-ecPublicKey`、曲线为 `prime256v1/secp256r1`、公钥点合法，并重新计算 device ID；不信任客户端提交的计算结果。
8. Bridge 原子消费令牌，并把设备绑定到当前 Access subject。

Bridge 公网 URL 在配置时必须满足：scheme 为 `https`，无 userinfo、query 或 fragment，path 为空或 `/`，端口为空或 `443`。签名使用的 `hostAscii` 由主机名执行 IDNA ToASCII、转小写并移除末尾点得到，不包含 scheme、路径或 `:443`。

后续认证：

1. Android 请求 challenge。
2. Bridge 生成规范小写 UUID `challengeId` 和 32 字节随机 `challengeRaw`，保存原始 32 字节、device ID、Bridge 已验证 Access assertion 的原始 `sub` 字符串、hostAscii、60 秒到期时间和单次使用状态。challenge 响应明确返回 `challengeId`、无 padding base64url 的 `challengeRaw` 和该原始 `accessSubject` 字符串；`challengeRaw` 在成功消费、到期或设备撤销时删除，且不得写入日志。
3. Android 必须使用 challenge 响应中收到的 `accessSubject` 原始字符串构造以下待签名字节，不从 opaque access token 推导 subject。所有长度为无符号大端，字符串使用 UTF-8，`accessSubject` 不执行 Unicode 归一化：

```text
ASCII("CLAUDE-REMOTE-DEVICE-AUTH-V1") || 0x00 ||
u16be(len(hostAscii))       || UTF8(hostAscii) ||
u16be(len(deviceId))       || ASCII(deviceId) ||
u16be(len(challengeId))    || ASCII(challengeId) ||
u32be(len(accessSubject)) || UTF8(accessSubject) ||
challengeRaw[32]
```

4. Android 使用 `SHA256withECDSA` 签名。签名编码固定为 ASN.1 DER `SEQUENCE(INTEGER r, INTEGER s)`，网络中使用无 padding base64url 字符串 `signatureDer`，不使用固定宽度 `r || s`。
5. 签名响应回传 `challengeId`、`accessSubject` 和 `signatureDer`。Bridge 先要求回传的 `accessSubject` 与 challenge 记录和当前 Access assertion 的原始 `sub` 字节完全相同，再从服务端记录重建全部待签名字节，严格解析 DER、验证 `1 <= r,s < n` 并验证 P-256 签名，然后原子消费 challenge。
6. Bridge 返回 256 位 opaque device session token，有效期十五分钟；数据库只保存其哈希。

仓库必须包含 Android 和 TypeScript 共用的固定认证测试夹具：测试公钥 SPKI DER、device ID、规范化 host、Access subject、challenge ID、challenge bytes、两端必须独立构造且字节完全相同的待签名内容 hex，以及一个可由两端验证的固定 DER signature。由于 ECDSA nonce 可随机化，不要求两端重新签名得到相同 signature bytes。另设互操作测试：TypeScript 测试私钥生成的签名由 Android 验证；Android Keystore 不可导出私钥生成的签名由 TypeScript 验证，两者只要求验签成功。

每个 HTTP 请求和 WebSocket Upgrade 除 Access bearer token 外，还必须携带 `X-Claude-Remote-Device-Session: <opaque token>`。设备会话以服务端时间判断到期，不依赖 Android 时钟。刷新设备会话必须重新完成一次性 challenge 签名。首版只允许一个未撤销设备；在 Mac 本地配对新设备前必须先撤销旧设备。

设备会话令牌是十五分钟有效的 bearer token，不宣称具备逐请求防重放能力。攻击者若同时获得仍有效的 Access 身份和设备令牌，可在到期前重用；风险通过短有效期、TLS、Keystore 加密存储、Access subject 绑定和即时撤销降低。首版不实现每请求签名或 DPoP。

认证端点按 Access subject、device ID 和来源 IP 限速。重复 challenge、重复配对令牌、错误签名和已撤销设备统一返回不泄露细节的认证失败。

### 10.4 设备撤销

Mac Bridge 提供仅本地可调用的管理命令，用于：

- 查看已配对设备。
- 撤销单个设备。
- 撤销全部设备。
- 重新生成配对二维码。

撤销事务会标记设备、删除其全部设备会话和未使用 challenge，并通过连接注册表立即关闭该设备的 HTTP 长请求与 WebSocket。后续签名即使有效也因设备已撤销而失败。

### 10.5 项目目录与本机资源

项目白名单只控制 Claude 会话的启动工作目录，不是文件系统沙箱。Claude Code 的 Bash、文件和 MCP 工具仍可能按本机用户权限访问项目外资源；是否允许取决于 Claude Code 权限规则和用户在手机上的决定。

项目授权在 Mac 本地完成，并保存：

- 规范化 realpath
- 文件系统设备号
- inode
- 显示名称

每次启动或恢复前重新解析 realpath，并校验设备号和 inode。路径已变、目录被替换或授权根本身是符号链接时拒绝启动。项目内部的符号链接不被视为安全边界，也不承诺阻止其指向外部。

App 只能提交 `projectId`，不能提交绝对路径。Bridge API 不提供原始 Shell、任意文件读取、任意文件下载或任意进程启动接口。Claude API key 和全部本机凭据始终留在 Mac。

若未来要求真正限制 Claude 只能访问项目目录，必须另行设计操作系统级沙箱；不把普通 realpath 检查描述成该能力。

### 10.6 审计日志

Bridge 使用权限 `0600` 的本地 JSONL 审计日志，单文件 10 MiB，保留五个轮转文件或三十天，以先达到者为准。

每条记录包含：

- 服务端时间和 audit event ID
- Access subject 的稳定哈希
- device ID
- Cloudflare Ray ID 和来源 IP（如果存在）
- request ID 和操作类型
- session ID 和 project ID
- 结果代码
- 权限事件的工具类别与 allow/deny 决定
- 连接、配对、认证失败和撤销事件

审计日志不保存完整 prompt、Claude 回复、工具原始参数、工具输出、stderr、OAuth token、设备令牌、API key 或文件内容。错误字符串进入日志前按 token、Authorization header 和常见凭据模式脱敏。日志轮转、权限和脱敏都有自动化测试。

## 11. 错误处理

### 11.1 网络与认证错误

- Android 使用带随机抖动的指数退避重连。
- Access `401` 或 `4401` 触发 OAuth refresh、设备 challenge refresh 和新 socket，不在旧 socket 内替换 token。
- 重连时 Android 提交每个 session 最后连续确认的 `eventId`。
- 重复事件由 Android 去重；缺少持久化事件时 Bridge 返回明确的 `4410`，不伪造连续性。

### 11.2 模糊命令结果

若连接在命令提交后、响应前断开，Android 不生成新操作，而是使用原 `idempotencyKey` 重试。Bridge 返回原命令的 `accepted`、`dispatching`、`dispatched`、`indeterminate`、`interrupted`、`completed` 或 `failed` 状态。

只有 `accepted` 且未派发的命令可取消。`dispatching` 或 `dispatched` 在进程异常后必须经过 transcript 证据协调，不能无限保持非终态。`indeterminate` 显示“结果无法确认”，并在 Phase 0 去重门槛通过后提供显式安全重试；`interrupted` 显示“消息已送达，但执行中断”，只提供恢复会话和发送新“继续”消息。

### 11.3 Claude Code 进程错误

- 非零退出时记录退出码和经过脱敏、限长的 stderr 摘要。
- App 将 session 标记为 `interrupted` 或 `failed`，不伪装成正常结束。
- 用户可按原 session ID 显式恢复。
- Bridge 重启后不假装恢复旧进程，也不自动重放最后一条用户消息。
- 启动超时、init session ID 不匹配和权限 Adapter 不兼容均终止进程并释放租约。

### 11.4 协议错误

- 未知 App 协议版本在握手阶段拒绝。
- 无法解析的 Claude Code 事件被保存为脱敏错误摘要，并使 session 进入 `failed`。
- Bridge 不降级到 PTY 文本解析或通用 Shell。
- MCP 权限结果 schema 不匹配时拒绝当前工具并终止该子进程。

### 11.5 权限错误

- 权限超时自动拒绝。
- 手机断线时未决请求保持等待，到服务端超时后拒绝。
- 来自非当前 Bridge 写入设备、错误 session、错误 tool use ID 或已解决请求的决定被拒绝。
- session Stop、Bridge 关闭和设备撤销都会先拒绝未决权限，再回收进程。

### 11.6 存储错误

- SQLite 事务失败时不向 Claude stdin 派发新命令。
- 未确认事件无法持久化时暂停接收新消息，并停止活动进程，避免产生无法交付的输出。
- 数据库损坏进入维护模式，只允许本地诊断和备份，不自动删除数据库或 transcript。

## 12. Android 界面

### 12.1 会话页

按状态分组显示：

- 等待批准
- 正在运行
- 已停止

每个会话显示项目名、标题、当前 Claude Code 报告的模型、状态和最后活动时间。页面提供新建会话和扫描旧会话按钮。

### 12.2 对话页

顶部显示：

- Bridge 和认证状态
- 项目名
- 当前模型（只读）
- session 状态

消息区域显示：

- 用户消息及其发送状态：已接受、派发中、已派发、结果不确定、执行中断、已完成或失败
- `indeterminate` 消息的“安全重试”操作（仅兼容门槛通过时）
- `interrupted` 消息的“恢复会话”和发送新“继续”消息操作
- Claude 回复
- 流式生成状态
- 可折叠工具调用卡片
- 带截断标记的可折叠工具输出
- 错误、中断和重新同步状态

底部提供消息输入、发送和停止按钮。`idle` 之外禁用普通发送；非终态命令显示服务端真实状态，防止用户凭感觉重复提交。

### 12.3 权限界面

权限请求使用不可误触的底部弹窗。命令执行和文件变更类别使用醒目样式，但不显示未经定义的风险分数。界面展示工具名、可提取的命令或路径、完整原始参数和倒计时。允许和拒绝按钮保持足够间距，默认焦点不放在允许操作上。

### 12.4 新建与导入会话页

新建会话只允许选择 Bridge 返回的授权项目，并可输入可选会话名称。模型沿用 Mac 默认配置，权限模式固定为 `default`；不提供模型、权限模式或任意路径输入框。

导入流程先选择授权项目，再显示该项目扫描到的候选 session。损坏记录、项目已移动和重复记录必须有明确状态。

### 12.5 连接页

显示：

- Cloudflare OAuth 登录状态和重新登录入口
- 扫码配对入口
- Tunnel 和 Bridge 状态
- App、Bridge、协议和 Claude Code 版本
- 当前设备身份
- Access 或设备会话即将到期提示
- 重新配对说明

视觉采用 Material 3、深色优先、对话优先的原生 Android 设计。

## 13. 测试策略

### 13.1 Bridge 与协议单元测试

覆盖：

- stream-json 事件解析和未知事件处理
- App 命令 envelope、响应关联和结构化错误
- RFC 8785 payload 规范化、SHA-256 hash 和相同 idempotency key 的重复提交
- 连接在 accepted、dispatching、dispatched 和 completed 各阶段断开的恢复
- `dispatching`/`dispatched` 崩溃后的 transcript 协调，以及显式安全重试
- 命令状态更新与 `command.status.changed` 事件的原子写入、断线补发和 request ID 关联
- session 状态机和非法状态转换
- Bridge 范围会话锁和 stale lease 清理
- `--session-id` 生成及 init ID 校验
- 持久化事件高水位、十进制字符串编码、ACK、删除全部旧事件后重启继续编号、重复 ACK、跳号 ACK 和 Bridge 重启补发
- 不可变 transcript snapshot 分页、尾部部分 JSONL、十分钟 cursor 过期、deliveryWatermark 与实时事件竞态
- checkpoint 同时恢复 session、非终态命令和 pending permission 状态
- 两阶段 snapshot commit：Room 成功前不前移 delivery position，prepared 期间普通 ACK 不能越过 `deliveryBase`，commit 幂等，响应丢失可重试，prepared/失败/过期快照不取代事件，成功后避免重复 `4410`
- 大型工具输出截断和全局存储压力
- 项目 realpath、设备号、inode 和符号链接处理
- session 导入去重、损坏记录和项目不匹配
- 审计日志字段、轮转、权限和凭据脱敏
- Stop、Release、Cancel 的不同语义

### 13.2 认证与安全测试

覆盖：

- PKCE verifier 和 `state` 校验
- Access assertion 的签名、issuer、audience、subject 和 expiry
- Access token 到期、refresh 和 WebSocket 重建
- WebSocket Upgrade 缺少 Access bearer 或设备令牌
- 配对令牌过期、重复使用和并发消费
- challenge 过期、重复使用和签名重放
- API 28 Keystore ECDSA P-256 能力探测、不可导出密钥和无安全降级
- Android/TypeScript 待签名字节固定夹具、共享 DER signature 验证和双向随机 ECDSA 签名互操作
- challenge 原始字节的短期保存、原子消费、到期清理和日志排除
- challenge 返回 Bridge 验证的原始 `accessSubject`，Android 使用该字符串签名，回传 subject 与 challenge 记录或当前 assertion 不匹配时拒绝
- device ID 与 Access subject 不匹配
- 设备会话令牌在有效期内可复用，以及到期、撤销或 Access 失效后的拒绝
- 被撤销设备的现有 WebSocket 立即关闭
- 路径穿越、授权目录替换和 project/session 绑定绕过
- 伪造 session ID、错误 tool use ID 和重复权限决定
- 异常 WebSocket 消息、协议降级和来源限速

### 13.3 Claude Code 真实集成测试

关键兼容路径必须使用固定版本和升级候选版本的真实 Claude Code CLI 验证：

- Phase 0 权限 MCP 探测：输入字段和单文本块 allow/deny 返回
- `--session-id` 与 `system/init.session_id` 一致
- 新建长驻 stream-json 多轮会话
- 按 session ID 在原项目恢复
- 在错误项目恢复时失败
- 进程重启并 resume 后，用户消息 UUID 重放不产生第二条 transcript 输入
- transcript 历史适配器能重建用户、assistant 和工具项，并在格式不兼容时明确失败
- 实际权限请求的允许一次、拒绝、超时和 MCP 断开
- `default` 模式下本机规则已允许的工具不产生手机提示
- Stop 的 SIGINT、SIGTERM 和 SIGKILL 回退
- Release 后 transcript 可再次恢复
- 子进程异常退出和租约包装器回收
- Bridge 崩溃时无孤儿 Claude 进程继续写入
- malformed stream-json 和不兼容权限结果失败关闭

模拟进程可用于快速单元测试，但不能替代真实 CLI 集成测试。Claude Code 升级前必须运行兼容套件。

### 13.4 Android 测试

覆盖：

- Compose 会话、导入和对话界面
- Room 历史投影、不可变 snapshot 分页、过期 cursor 重启、检查点原子替换和实时事件叠加
- Room 事务原子保存 projection、watermark、commit idempotency key 和 `checkpoint_commit_pending`
- App 在 Room 成功后、commit 前或等待响应时崩溃，重启后先重试同一 commit，且 pending 期间普通 ACK 不越过 `deliveryBase`
- commit 返回 `410 SNAPSHOT_EXPIRED` 时废弃该 projection 并重建，不确认旧 watermark
- `4410` 后恢复 session、命令和 pending permission 状态且不重复循环
- `command.status.changed` 的持久化重放、request ID 关联和去重
- 消息的确认中、派发中、已派发、结果不确定、执行中断、完成和失败状态
- `indeterminate` 消息的显式安全重试
- 流式消息渲染和工具输出截断提示
- 权限弹窗、超时和重复点击
- OAuth Auth Tab/App Link 回调
- OkHttp HTTP 与 WebSocket bearer/device header
- WebSocket 断线重连和 token refresh 串行化
- 事件去重、跳号检测和 `4410` 重新同步
- API 28 Keystore ECDSA P-256 能力探测、签名和 refresh token 加密
- 前后台切换
- App/Bridge 协议版本不兼容提示

### 13.5 真实端到端测试

最终验收必须使用真实 Android 设备、真实 Mac Bridge、真实 Cloudflare Access 应用和 Tunnel：

- 完整 OAuth 登录、扫码配对、建会话、权限批准和恢复路径
- Access token 在活动使用期间到期后的 refresh 与重连
- 手机在权限请求期间断网并超过超时
- 未确认事件存在时重启 Bridge
- 活动 Claude 进程存在时强制结束 Bridge
- 撤销设备并观察现有 socket 关闭
- 关闭 Tunnel 后从公网和局域网验证 Bridge 不可达

## 14. 首版验收标准

1. Phase 0 分别验证 Claude 权限/UUID 去重、Cloudflare OAuth/WebSocket 和 transcript 历史转换；任一门槛失败则不继续对应实现。
2. Android 9（API 28）设备能生成不可导出的 Keystore ECDSA P-256 密钥；不支持的设备在配对前明确失败。
3. Android 通过 Cloudflare Managed OAuth + PKCE 登录，Bridge 验证 Access assertion。
4. Mac 显示五分钟单次二维码，Android 完成 ECDSA P-256 设备配对。
5. Challenge 响应返回 Bridge 验证的原始 Access subject 供 Android 签名；回传 subject 不一致、重放配对令牌或重放 challenge 均失败。设备会话令牌在有效期内按 bearer 语义可复用，但在到期、设备撤销、Access subject 不匹配或 Access 认证失效后必须失败。
6. 未配对设备无法访问任何会话信息。
7. Android 能列出 Bridge 会话，并从指定授权项目导入至少一个有效旧 session；损坏和项目不匹配记录被拒绝。
8. 打开导入或恢复的 session 时，Android 能从十分钟有效的不可变 transcript snapshot 分页显示既有用户、assistant 和工具历史；尾部部分 JSONL 不被误解析，解析失败会明确标记历史不完整。
9. Android 能在授权项目以 Bridge 生成的 session ID 新建会话，init 返回同一 ID。
10. Claude 回复实时流式显示；初始响应后的命令状态通过可补发的 `command.status.changed` 事件更新，消息可区分 accepted、dispatching、dispatched、indeterminate、interrupted、completed 和 failed。
11. 相同 idempotency key 和相同 JCS payload 在任意网络重试下只对应一个命令；相同键不同 payload 被拒绝。
12. 在 stdin 派发崩溃窗口产生的命令显示为 `indeterminate`，不会自动重放；用户执行安全重试后 transcript 只出现一条该 UUID 的用户消息。
13. 实际产生的 Bash 或文件工具权限提示能在手机允许一次或拒绝，且不会写入永久权限规则。
14. 权限请求期间断网并超过五分钟后默认拒绝。
15. 手机断网并重连后，全部未确认协议事件不丢失且不重复；大型输出的截断必须明确显示。
16. 删除全部已确认事件并重启 Bridge 后，新事件 ID 仍严格递增，且以十进制字符串传输。
17. 未确认事件存在时重启 Bridge，事件仍能补发。
18. 收到 `4410` 后，Android 能通过一致性检查点原子恢复历史、session 状态、非终态命令、pending permission 和 `deliveryWatermark`，并在同一 Room 事务保存待提交 checkpoint。事务后任意时点崩溃都能以原 idempotency key 重试 commit；pending 期间普通 ACK 不越过 `deliveryBase`，过期快照不确认旧 watermark；提交后再接续实时事件且同一批不兼容事件不会重复触发 `4410`。
19. Bridge 崩溃后没有租约包装器管理的孤儿 Claude 进程继续写入。
20. 用户能区分 Stop 和 Release，并在 Release 后用原 session 恢复。
21. Bridge 重启后不会自动重放用户消息，用户可显式恢复原 session。
22. 通过 Bridge 发起的同一 session 第二写入者被拒绝；UI 同时说明普通终端不受该锁保护。
23. 白名单外目录、被替换目录和项目不匹配 session 无法通过 App 创建或恢复。
24. Access 或设备会话到期会关闭 socket，App refresh 后能恢复连接。
25. 撤销手机设备后，现有连接和全部设备令牌立即失效。
26. 不兼容 App 协议、malformed stream-json 和权限 Adapter schema 变化均明确失败，不降级到 Shell 或 PTY。
27. 审计日志不包含 prompt、完整命令参数、token、API key 或文件内容，并按策略轮转。
28. Cloudflare Tunnel 关闭后，本机没有可被局域网或公网直接访问的 Bridge 端口。

## 15. 已知风险

- `--permission-prompt-tool` 的完整 JSON 契约未进入公开文档，必须固定 Claude Code 兼容范围并以 Phase 0 和升级测试保护。
- Claude Code stream-json 事件可能随版本扩展，Bridge 必须保持版本化适配层。
- 历史 session 文件格式不是实时控制 API，导入功能只能读取最小字段并允许失败。
- 普通终端可绕过 Bridge 锁直接恢复同一 session，系统只能通过流程警告降低并发写入风险。
- 项目白名单不是文件系统沙箱；用户批准的 Claude 工具仍可能访问项目外资源。
- Cloudflare Managed OAuth 文档没有单独保证 WebSocket Upgrade 的 bearer 行为，必须在真实 Access 应用中通过端到端门槛验证。
- Cloudflare Access、Tunnel 和用户配置错误仍可能扩大暴露面，需要提供部署前自检。
- 设备会话令牌是短期 bearer token，不提供逐请求防重放；令牌和有效 Access 身份同时泄露时存在到期前重用窗口。
- Android Keystore 实现存在厂商差异，API 28 能力探测必须阻止不满足不可导出 P-256 要求的设备。
- 未确认事件包含临时对话内容；本机数据库权限、备份策略和 ACK 后删除必须正确实现。
- 长时间运行的 Claude 子进程和大型工具输出可能消耗资源，首版通过事件截断、存储背压和显式 Stop 控制，不承诺多会话性能指标。

## 16. 后续版本候选

以下功能不进入首版：

- 图片和文件上传
- 后台系统通知
- 平板布局
- 手机端模型选择和模型发现
- 手机端永久权限规则编辑
- 操作系统级项目沙箱
- 本地原始事件查看器
- 多设备同时只读观察
- 设备会话的逐请求签名或 DPoP
- 自动打开 Mac 终端并恢复 session
- 多用户权限管理
