# Claude Remote Android 设计规格

日期：2026-08-02

## 1. 背景

用户希望在 Android 手机上获得接近本机 Claude Code 的对话体验，包括查看会话、继续旧会话、新建会话、接收流式回复，以及批准或拒绝工具调用。

该方案不得使用 Claude 官方 Remote Control 服务。手机通过 Cloudflare Tunnel 访问用户 Mac 上的自托管桥接服务，Claude 模型请求仍由 Mac 上现有的 Claude Code 配置发往当前 API 服务。

## 2. 目标

首版必须支持：

- 仅供单个用户本人使用。
- Android 原生对话界面。
- 新建 Claude Code 会话。
- 查看 Bridge 管理的会话，并导入本机已有会话。
- 按 session ID 恢复旧会话。
- 实时显示 Claude 回复、状态和工具调用。
- 在手机上批准或拒绝工具权限。
- 手机断线后重连并补齐事件。
- Mac Bridge 重启后通过 session ID 恢复会话。
- 通过 Cloudflare Tunnel 从公网安全访问。
- 通过 Cloudflare Access 和设备密钥进行双层认证。

## 3. 非目标

首版不支持：

- 直接附着到已经在普通终端中运行的 Claude Code 进程。
- 同一 session 在手机和终端中同时输入。
- 任意远程 Shell、通用文件浏览或文件下载。
- 图片及文件上传。
- App 退到后台后的云推送通知。
- 多用户、公开注册、租户隔离或配额管理。
- 复制 Claude 官方 App 的品牌资源或界面。
- 使用不稳定的 PTY 文本解析作为主要控制协议。

## 4. 技术约束

Claude Code 没有面向第三方的接口，可附着到任意已运行的交互式终端进程。自托管方案采用以下受支持能力：

- `claude -p`
- `--input-format stream-json`
- `--output-format stream-json`
- `--include-partial-messages`
- `--permission-prompt-tool`
- `--resume <session-id>`

Bridge 必须拥有它控制的 Claude Code 子进程。旧会话通过新的子进程按 session ID 恢复，而不是接管旧进程。

`~/.claude/projects/` 只作为历史记录导入来源，不作为实时控制协议。Bridge 不修改其中的文件，并将格式解析隔离在兼容适配器中。

## 5. 总体架构

```text
Android App
    │
    │ HTTPS / WebSocket
    ▼
Cloudflare Access + Tunnel
    │
    ▼
Mac Bridge Service (127.0.0.1 only)
    │
    │ stream-json over stdin/stdout
    ▼
Claude Code CLI child process
    │
    ├── project files
    ├── user/project settings
    ├── MCP servers
    ├── hooks
    └── session transcripts
```

项目采用独立仓库，包含两个主要程序：

- `android/`：Kotlin + Jetpack Compose Android App。
- `bridge/`：TypeScript + Node.js Mac 后台服务。

Bridge 由 macOS `launchd` 自动启动。Cloudflare Tunnel 将单一公网主机名转发到 Bridge 的本地端口。Bridge 不监听局域网或公网网卡。

## 6. 组件边界

### 6.1 Android App

职责：

- 设备首次配对。
- 保存设备私钥和短期访问令牌。
- 显示连接状态和 Bridge 状态。
- 浏览会话列表。
- 新建、恢复、停止和释放会话。
- 发送用户消息。
- 渲染流式回复和结构化工具事件。
- 展示权限请求并提交批准或拒绝。
- 断线重连和事件补齐。

Android App 不保存 Claude API key，不直接调用 Claude API，也不能提交任意本机路径或 Shell 命令。

### 6.2 Mac Bridge

职责：

- 设备配对、身份认证和设备撤销。
- 授权项目目录管理。
- 会话索引和单写入者锁。
- Claude Code 子进程生命周期管理。
- stream-json 协议转换。
- 权限请求和用户决定的往返传递。
- 事件编号、短期缓存和重连补发。
- 安全审计记录。

Bridge 对外只提供定义明确的会话操作，不提供通用命令执行接口。

### 6.3 Session Supervisor

每个活动 session 对应一个受 Supervisor 管理的 Claude Code 子进程。Supervisor 负责：

- 构造受控 CLI 参数。
- 设置工作目录。
- 连接 stdin、stdout 和 stderr。
- 解析流式事件。
- 将权限请求挂起，等待手机决定。
- 跟踪进程状态和退出原因。
- 在停止、超时或异常时正确回收进程。

### 6.4 Session Index

Bridge 使用 SQLite 保存：

- session ID
- 显示名称
- 项目目录标识
- 模型
- Bridge 状态
- 最后活动时间
- 最后确认的事件序号
- 是否由 Bridge 创建

SQLite 不复制保存完整对话、Claude API key 或 MCP 凭据。

首次使用时，历史导入适配器可只读扫描 `~/.claude/projects/`，提取最少的会话元数据。解析失败时，用户仍可手动输入 session ID 和已授权项目来恢复。

## 7. 会话生命周期

### 7.1 新建会话

1. Android 请求授权项目列表。
2. 用户选择项目、模型和允许的权限模式。
3. Bridge 验证项目仍在白名单内。
4. Bridge 生成 session ID 并创建索引记录。
5. Session Supervisor 在该项目目录启动 Claude Code 子进程。
6. Android 订阅该 session 的事件流。

### 7.2 恢复会话

1. Android 选择历史 session。
2. Bridge 获取该 session 的写入锁。
3. 若检测到已有 Bridge 子进程，则复用现有进程。
4. 否则以 `--resume <session-id>` 启动新进程。
5. Bridge 将新事件接续到统一的事件序列。

Bridge 不尝试附着到普通终端中的现有进程。

### 7.3 手机与桌面切换

同一 session 同时只能有一个写入者。

从手机切回终端：

1. 用户在 App 中选择“释放会话”。
2. Bridge 停止接收新消息，并结束该 session 的无头子进程。
3. App 显示可复制的 `claude --resume <session-id>` 命令。
4. 用户在 Mac 终端恢复会话。

从终端切回手机：

1. 用户先退出终端中的该 Claude Code 会话。
2. 用户在 App 中选择恢复。
3. Bridge 重新获取写入锁并按 session ID 启动进程。

Bridge 不支持两个写入者并发修改同一会话记录。

## 8. 消息与事件协议

Android 与 Bridge 使用版本化的 JSON 消息，通过 WebSocket 传输。

所有服务端事件包含：

- `protocolVersion`
- `eventId`
- `sessionId`
- `eventType`
- `timestamp`
- `payload`

核心事件类型：

- `session.state.changed`
- `assistant.message.delta`
- `assistant.message.completed`
- `tool.started`
- `tool.output.delta`
- `tool.completed`
- `permission.requested`
- `permission.resolved`
- `process.stderr`
- `session.interrupted`
- `session.failed`

Android 保存每个 session 最后确认的 `eventId`。重连时提交该编号，Bridge 补发尚未确认的事件。客户端按 `eventId` 去重。

Bridge 只做 Claude Code stream-json 与 App 协议之间的转换，Android 不依赖 Claude Code 的原始事件格式。

## 9. 工具权限

Bridge 使用 Claude Code 的非交互权限提示接口处理工具审批。

权限请求在 Android 中必须显示：

- 工具名称
- 完整参数
- 目标命令或路径
- 文件修改摘要（如果可用）
- 风险等级
- 请求时间

首版仅提供：

- 允许一次
- 拒绝

不提供永久允许、自动允许或绕过权限。权限请求超过设定时间未处理时自动拒绝。

## 10. 公网安全

### 10.1 网络边界

- Bridge 仅绑定 `127.0.0.1`。
- Cloudflare Tunnel 是唯一公网入口。
- 不配置路由器端口转发。
- Tunnel 停止后，Bridge 不应从局域网或公网直接访问。

### 10.2 双层认证

第一层为 Cloudflare Access，用于阻挡未经授权的公网请求。

第二层为 Bridge 自有设备认证：

1. Mac 生成短期、单次使用的配对令牌并显示二维码。
2. Android 在系统 Keystore 中生成不可导出的设备密钥。
3. Android 扫码并提交设备公钥和配对令牌。
4. Bridge 保存设备公钥，并立即废止配对令牌。
5. 后续连接使用随机挑战签名换取短期访问令牌。

配对令牌必须设置短有效期、单次使用限制和速率限制。

### 10.3 本机资源保护

- Claude API key 和全部本机凭据留在 Mac。
- Bridge 维护明确的项目根目录白名单。
- 所有路径在使用前规范化并验证仍位于授权根目录中。
- App 不允许提交任意绝对路径。
- Bridge API 不提供原始 Shell、任意文件读取或任意进程启动能力。
- 所有会话操作写入安全审计日志，但不复制完整对话内容。

### 10.4 设备撤销

Mac Bridge 提供本地管理命令，用于：

- 查看已配对设备。
- 撤销单个设备。
- 撤销全部设备。
- 重新生成配对二维码。

设备撤销后，现有短期令牌和 WebSocket 连接必须失效。

## 11. 错误处理

### 11.1 网络错误

- Android 使用指数退避重连。
- 重连时按最后确认的事件编号补发。
- 重复事件由 Android 去重。
- Bridge 为每个 session 保留有界事件缓存。

### 11.2 Claude Code 进程错误

- 非零退出时记录退出码和经过清理的 stderr。
- App 将 session 标记为“已中断”，而不是伪装成正常结束。
- 用户可按原 session ID 再次恢复。
- Bridge 重启后不假装恢复旧进程，只恢复会话记录。

### 11.3 协议错误

- 未知协议版本被明确拒绝。
- 无法解析的 Claude Code 事件进入受控错误状态。
- Bridge 不降级到 PTY 文本解析或通用 Shell。
- 连续协议错误触发该 session 子进程停止。

### 11.4 权限错误

- 超时自动拒绝。
- 断线时未处理的高风险权限请求保持暂停，达到超时后拒绝。
- 来自非当前写入设备或错误 session 的权限决定被拒绝。

## 12. Android 界面

### 12.1 会话页

按状态分组显示：

- 等待批准
- 正在运行
- 已停止

每个会话显示项目名、标题、模型、状态和最后活动时间。页面提供新建会话按钮。

### 12.2 对话页

顶部显示：

- Bridge 连接状态
- 项目名
- 模型
- session 状态

消息区域显示：

- 用户消息
- Claude 回复
- 流式生成状态
- 可折叠工具调用卡片
- 可折叠工具输出
- 错误与中断状态

底部提供消息输入、发送和停止按钮。

### 12.3 权限界面

权限请求使用不可误触的底部弹窗。高风险命令和敏感路径使用醒目样式。允许和拒绝按钮保持足够间距，默认焦点不放在允许操作上。

### 12.4 新建会话页

用户只能选择 Bridge 返回的授权项目，并可选择：

- 会话名称
- 模型
- 支持的权限模式

不提供任意路径输入框。

### 12.5 连接页

显示：

- 扫码配对入口
- Tunnel 和 Bridge 状态
- Bridge 协议版本
- 当前设备身份
- 重新配对说明

视觉采用 Material 3、深色优先、对话优先的原生 Android 设计。

## 13. 测试策略

### 13.1 Bridge 单元测试

覆盖：

- stream-json 事件解析
- App 协议转换
- 会话锁
- 事件编号、补发和去重
- 目录白名单和路径规范化
- 配对令牌生命周期
- 设备签名验证
- 权限超时
- 进程状态转换

### 13.2 安全测试

覆盖：

- 签名重放
- 过期和重复使用的配对令牌
- 过期访问令牌
- 被撤销设备
- 路径穿越
- 伪造 session ID
- 未授权项目目录
- 异常 WebSocket 消息
- 事件序号伪造
- 并发写入者

### 13.3 Claude Code 集成测试

关键兼容路径必须使用真实 Claude Code CLI 验证：

- 新建多轮会话
- 流式部分消息
- session resume
- 工具权限允许
- 工具权限拒绝
- 子进程异常退出
- Bridge 重启后的恢复

模拟进程可用于快速单元测试，但不能替代真实 CLI 集成测试。

### 13.4 Android 测试

覆盖：

- Compose 会话和对话界面
- 流式消息渲染
- 权限弹窗
- WebSocket 断线重连
- 事件去重
- Keystore 密钥
- 前后台切换
- Bridge 版本不兼容提示

最终验收必须在真实 Android 设备和真实 Mac Bridge 上完成。

## 14. 首版验收标准

1. Mac 能显示一次性二维码，Android 能完成配对。
2. 未配对设备无法访问任何会话信息。
3. Android 能列出 Bridge 会话并导入至少一个已有 session。
4. Android 能在授权项目中新建会话。
5. Claude 回复能实时流式显示。
6. Bash 和文件修改权限能在手机批准或拒绝。
7. 手机断网并重连后，消息不丢失且不重复。
8. Bridge 重启后，用户能恢复原 session。
9. 同一 session 的第二个写入者会被拒绝。
10. 白名单外目录无法通过 App 创建或恢复会话。
11. 撤销手机设备后，现有连接和令牌立即失效。
12. Cloudflare Tunnel 关闭后，本机没有可被外部直接访问的 Bridge 端口。

## 15. 已知风险

- Claude Code stream-json 事件可能随版本扩展，Bridge 必须保持版本化适配层。
- 历史 session 文件格式不是实时控制 API，导入功能必须只读取最小字段并允许失败。
- 普通终端与 Bridge 无法同时安全写入同一 session，需要明确的释放流程。
- Cloudflare Access 与 Android WebSocket 的令牌刷新需要在实施计划中验证具体集成方式。
- 长时间运行的 Claude 子进程可能消耗资源，实施时需要定义空闲回收策略和最大活动会话数。

## 16. 后续版本候选

以下功能不进入首版：

- 图片和文件上传
- 后台系统通知
- 平板布局
- 本地原始事件查看器
- 多设备同时只读观察
- 自动打开 Mac 终端并恢复 session
- 多用户权限管理
