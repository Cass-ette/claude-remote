# Bridge Admin GUI（macOS 菜单栏 App + 本机 Admin API）设计

日期：2026-09-15
状态：已与用户对齐（方案 A：专用 loopback API + SwiftUI 菜单栏 App）

## 1. 背景与问题

Bridge 目前所有运维操作都依赖终端或 Claude 会话执行：

| 操作 | 现状 |
|---|---|
| 项目授权（authorize / revoke / list-projects） | `bridge admin` CLI |
| 设备管理（list-devices / revoke-device / revoke-all-devices） | `bridge admin` CLI |
| 配对二维码（pairing-qrcode） | 终端字符画 QR |
| 状态确认（bridge / 隧道 / 会话） | `launchctl` + curl |
| 日志与审计排查 | launchd stdout 文件 / sqlite 查询 |

此外 CLI 有一个已知缺陷（`src/admin/cli.ts` 头注释）：CLI 撤销设备只写共享数据库，**碰不到运行中 bridge 的内存态**——该设备的已建立 WebSocket 与挂起的权限请求不会被立即清理，要等 bridge 自行察觉。

## 2. 目标

为 Mac 用户提供一个常驻菜单栏 GUI，覆盖三类能力（用户已确认范围）：

1. **授权管理**：项目授权/撤销/列表；设备列表/撤销/全部撤销；配对二维码展示（图片级清晰度）
2. **状态面板**：bridge 运行状态与 uptime、隧道公网可达性、活跃 Claude 会话、设备会话过期倒计时
3. **日志/审计查看**：bridge.out/err.log 尾部流式查看、audit_events 分页浏览

非功能性目标：

- 撤销设备必须**立即**生效（断 socket + 拒 pending permissions），优于 CLI
- 不引入新的公网攻击面
- 用户日常运维不再需要打开终端或依赖 Claude 会话

## 3. 非目标（明确排除）

- **服务控制**：不在 GUI 内启停/重启 bridge 或 cloudflared launchd 服务（用户明确排除；GUI 只展示一行可复制的 launchctl 命令文案）
- 替换或删除 admin CLI（CLI 保留，两者并存共用同一域层）
- Android 端任何改动
- SSE/WebSocket 实时推送（轮询足够，YAGNI）
- 多用户/多 Mac 场景（单用户单机）

## 4. 总体架构

```
┌─ macOS 菜单栏 App (SwiftUI, macos/BridgeBar) ─┐      ┌─ Android App ─┐
│  读 token 文件 + 轮询 API，纯薄客户端        │      └──────┬─────────┘
└──────────────┬───────────────────────────────┘             │ 公网
               │ 127.0.0.1:43112, bearer token          Cloudflare Access
               ▼                                               ▼
┌─ Bridge 进程（单一 launchd 服务）─────────────────────────────────┐
│  Admin API server（新增，不进隧道）    公网 API server（43111，现有）│
│  复用 ProjectRegistry / DeviceAuth / AuditLog 域逻辑（与 CLI 同层）│
└────────────────────────────────────────────────────────────────────┘
```

组件划分：

- **`bridge/src/admin/api-server.ts`** — 第二个 Fastify 实例，与现有 `startHttpServer` 同模式（返回未 listen 的 app，由 main.ts owns listen/close）。绑 `127.0.0.1`，端口默认 `43112`（`BRIDGE_ADMIN_PORT` 可配，校验规则与主端口一致）。
- **`bridge/src/admin/admin-token.ts`** — token 生命周期：首次启动生成 32 字节随机 token（base64url），写 `<dataDir>/admin-api-token`，权限 0600；文件已存在则复用，**bridge 重启不轮转**（轮转会把 App 锁在外面）。
- **域逻辑以复用为主** — 写路径直接调 ProjectRegistry / DeviceAuth / AuditLog 现有接口；与 CLI 唯一差别是吊销传入**真实** `RevocationHooks`（main.ts `revokeDevice` 内现有内联 hooks 适配：`broker.denyAllForDevice` + `wsService.closeDevice`；实现计划应把它提炼成具名共享函数，供 main.ts 与 admin API 两处调用）。**读路径需要新写少量查询**（现有域层是写导向）：审计游标分页、会话列表（含 join `session_locks` 取 `lockedBy`）、活跃会话计数、按 deviceId 查设备会话有效期、DB 体积——都是薄查询，落在 api-server 内的只读 DAO 小模块。
- **配置接线** — `LOOPBACK_HOSTS` / 端口解析目前是 config.ts 模块私有，需小幅导出重构供 admin server 复用同一套校验。

### 安全不变量

1. Admin API 只绑 loopback（复用 `LOOPBACK_HOSTS` 校验），cloudflared 配置只代理 43111 → admin 端口**公网物理不可达**，即使路由泄漏也不在隧道后面
2. 所有 `/admin/v1/*` 请求必须携带 `Authorization: Bearer <token>`；缺失/错误返回 401 并写 `admin.auth_failed` 审计事件（本机进程仍可能触达，token 是第二道闸）；同方向失败审计做最小限流——每 10 秒窗口至多记一条，防止本机失控进程刷爆审计表
3. token 文件权限 0600，内容永不进审计、永不进日志、永不通过 API 返回
4. GUI 的所有变更操作（授权/撤销/配对出码）写 `admin.*` 审计事件，与 CLI 对齐
5. 配对 token / QR payload 仅经本机 API 出给本机 App，不经隧道

## 5. Admin API 规范（`/admin/v1/*`，全 JSON）

通用错误体：`{"error": {"code": string, "message": string}}`；鉴权失败统一 401 `unauthorized`。

### GET /status

聚合快照，App 每 5 秒轮询一次：

```jsonc
{
  "uptimeSeconds": 123456,
  "publicReachable": true,        // 对 https://<publicHost>/api/v1/health 发起探测：
                                  // 任何 HTTP 响应（含 CF 401/302）= 隧道通；超时/连接失败 = 断
  "activeSessions": 2,            // sessions 表运行中数量
  "device": {                     // 当前唯一活跃设备（无则 null）
    "deviceId": "...", "displayName": "...", "pairedAt": 0,
    "sessionExpiresAt": 0,        // device_sessions 最晚有效期（"即将过期 N 分钟"的数据源）
    "sessionRevoked": false
  },
  "dbSizeBytes": 1048576,
  "version": "0.1.0"
}
```

探测请求由 bridge 自身发起（带 3 秒超时），不缓存；`publicReachable` 为 false 时 App 图标转黄。

### 项目管理

- `GET /projects` → `[{projectId, name, path, authorizedAt}]`
- `POST /projects` `{path, name}` → 201 + 项目对象；path 必须绝对路径且目录存在（沿用 registry 校验）
- `DELETE /projects/:projectId` → 204；不存在返回 404

### 设备管理

- `GET /devices` → `{active: Device | null, revoked: [Device]}`（§10.3 单设备规则）
- `POST /devices/:deviceId/revoke` → 204；404 `device_not_found`
- `POST /devices/revoke-all` → 204（幂等）
- 吊销直接调 `devices.revokeDevice`（域层既有语义，**勿另写路径**）：库事务先提交，随后按序执行 hooks（`denyPendingPermissions` → `closeSockets`），与 main.ts 现有吊销接线一致

### 配对

- `POST /pairing/qrcode` → `{payload: "claude-remote://pair?host=...&token=...", expiresAt}`
  - payload 用运行中 bridge 的 `config.publicHost` 构造（不像 CLI 依赖 BRIDGE_PUBLIC_HOST 环境变量）
  - bridge 以纯本机模式运行（`config.publicHost` 未设）→ 409 `public_host_unset`，message 指引设 `BRIDGE_PUBLIC_HOST` 后重启
  - 已有活跃设备 → 409 `{code: "already_paired"}`；App 弹"撤销旧设备并重新配对"确认，确认后先 revoke 再重新出码
  - QR 图片由 App 用 CoreImage 渲染，API 只传 payload 字符串（token 不落日志）

### 会话 / 审计 / 日志

- `GET /sessions` → `[{sessionId, projectId, status, lockedBy, startedAt, updatedAt}]`（只读观测，不含消息内容）
- `GET /audit?limit=50&cursor=<auditId>` → `{items: [...], nextCursor: string | null}`，按 `auditId` 倒序（主键即 audit_events 的 auditId）
- `GET /logs/tail?file=out|err&bytes=32768` → `{content: string}`，读日志尾部 N 字节（上限 256KB，越界取上限）。路径约定为 **`<dataDir>/logs/bridge.{out,err}.log`**（launchd StandardOut/ErrPath 现行落点；该约定写入 api-server 常量作为唯一事实源，`file` 参数仅白名单 `out|err`，杜绝路径穿越）

## 6. macOS App（`macos/BridgeBar/`，Xcode 项目，Swift 6 / macOS 26）

### 形态

- `MenuBarExtra` + `LSUIElement=true`：常驻菜单栏，不占 Dock
- 图标三态：**绿** = bridge 可达且 `publicReachable=true`；**黄** = bridge 可达但隧道断 / 设备会话 24h 内过期；**红** = bridge API 连续失败
- 轮询节奏：前台面板打开时 5s，菜单收起时 30s；失败指数退避（1s→2s→…→60s 封顶），成功即复位

### 下拉面板（轻交互）

- 状态卡：uptime、隧道可达性、活跃会话数、设备会话过期倒计时
- 快捷操作：「配对新设备」（QR 弹窗，已有设备时走撤销确认流）、「撤销此设备」

### 管理窗口（点"打开管理窗口"）

Tab 布局，承载全量操作：

| Tab | 内容 |
|---|---|
| 项目 | 列表 + 授权表单（路径选择器 NSOpenPanel + 名称）+ 撤销（带确认） |
| 设备 | 活跃设备卡 + 历史撤销记录；撤销带确认 |
| 会话 | 活跃会话表（状态、锁持有者、时间），只读 |
| 审计 | audit_events 倒序分页列表 |
| 日志 | out/err 切换、自动滚动、暂停按钮、清屏显示 |

### 技术约定

- 零第三方依赖：`URLSession`、`CIQRCodeGenerator`、`SMAppService`（开机自启开关）
- token 发现：默认读 `~/.local/share/claude-remote/admin-api-token`，App 设置内可改 data dir 路径；base URL 默认 `http://127.0.0.1:43112` 可改
- 网络层一个 `AdminClient` actor：请求封装 + 错误归一化（`unreachable / unauthorized / api(code, message)` 三类），供视图层直接 switch
- 状态层一个 `BridgeStatusStore`（`@Observable`）：持有最近 /status、轮询调度、退避状态；纯逻辑部分（状态→图标映射、退避计算）独立成可测类型

## 7. 错误处理

| 场景 | Bridge 侧 | App 侧 |
|---|---|---|
| bridge 进程不在 | — | 图标红 +「Bridge 未运行」+ 可复制的 `launchctl kickstart -k ...` 命令文案（不代执行） |
| token 不匹配 / 文件缺失 | 401 + `admin.auth_failed` 审计 | 「token 与 bridge 不匹配，检查 data dir 设置」；退避重试 |
| 隧道断（publicReachable=false） | /status 如实报告 | 图标黄 + 状态卡红点标注「隧道不可达」 |
| 配对时已有活跃设备 | 409 `already_paired` | 确认弹窗「撤销旧设备并重新配对？」→ revoke + 出码两步串联 |
| 配对时 bridge 无 publicHost（纯本机模式） | 409 `public_host_unset` | 提示设 `BRIDGE_PUBLIC_HOST` 后重启 bridge，出码按钮禁用 |
| API 业务错误（404/校验失败等） | 统一 `{error:{code,message}}` | 内联展示 message，不静默吞 |

## 8. 测试与验收

### Bridge 侧（vitest，照 http-routes 测试模式，注入 fake deps）

- 无/错 bearer → 401 且写 `admin.auth_failed`；10 秒窗口内第二次失败**不再**写第二条审计（验证 §4 限流不变量）
- 各路由 happy path（projects 增删查、devices 查/撤销/全撤、pairing 出码、sessions/audit/logs 读）
- 撤销设备时 hooks 按序被调用（denyPendingPermissions → closeSockets）且审计落库
- `already_paired` 409 路径
- logs/tail `bytes` 上限收敛、file 参数白名单（防路径穿越）
- admin server 拒绝非 loopback bind（沿用 config 校验测试模式）

### App 侧（XCTest）

- AdminClient 错误归一化（unauthorized / unreachable / api error）
- 状态→图标三态映射、退避计算、会话过期倒计时格式化
- SwiftUI 视图手动验收（无 UI 自动化）

### 端到端验收清单（真机真桥）

1. 菜单栏图标三态真实切换（正常 → 停 cloudflared → 黄；停 bridge → 红）
2. 从 App 撤销设备 → 手机连接**立即**断开（不等下次请求）
3. App 出配对码 → 手机扫码 → OAuth 全流程配对成功
4. 上述每个操作在审计 Tab 可见对应 `admin.*` 事件
5. 日志 Tab 能实时追到新日志行

## 9. 文件布局与部署

```
bridge/src/admin/api-server.ts      # Admin Fastify 实例 + 路由
bridge/src/admin/admin-token.ts     # token 生成/复用/校验
bridge/src/admin/cli.ts             # 不动（CLI 保留）
bridge/test/admin/                  # 对应测试
macos/BridgeBar/                    # Xcode 项目（App 源码 + Info.plist）
```

部署变化最小：

- bridge 仍是一个 launchd 服务；`npm run build` + launchctl 重启后 admin API 随进程启动
- launchd plist 增加 `BRIDGE_ADMIN_PORT=43112`（可选，默认值即可）
- App：Xcode Release 构建拖入 /Applications；ad-hoc 签名即可（个人使用，不上架）
