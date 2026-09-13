# Claude Remote 故障排查（Troubleshooting）

按 **症状 → 原因 → 处理** 组织，条目来自 spec §11/§15 与实际实现。命令中的 `<data-dir>` 指 Bridge 数据目录（安装器默认 `~/.local/share/claude-remote`）。

## 速查表

WebSocket 应用层 close code（定义于 `bridge/src/server/websocket-server.ts` 的 `CLOSE_CODE`，spec §8.1）：

| Code | 名称 | 含义 |
| --- | --- | --- |
| 4401 | `AUTH_INVALID` | Access 或设备认证失效/过期/被撤销；或被同设备的新连接取代 |
| 4403 | `FORBIDDEN` | 设备或项目未授权（例如"another device is already connected"） |
| 4409 | `SESSION_CONFLICT` | 会话写冲突（HTTP 命令路径返回 409，code 同名） |
| 4410 | `RESYNC_REQUIRED` | 客户端必须通过 snapshot begin/commit 重新同步 |
| 4426 | `PROTOCOL_INCOMPATIBLE` | 协议版本不兼容（subprotocol `claude-remote.v1`） |
| 4500 | `INTERNAL_ERROR` | Bridge 内部错误；Bridge 关闭时也以此码关闭全部连接 |

HTTP：`503` + `code=STORAGE_PRESSURE`（存储压力，见下）；`409` + `code=SESSION_CONFLICT`。

诊断入口：

```bash
# Bridge 运行日志（launchd 写入）
tail -f <data-dir>/logs/bridge.err.log <data-dir>/logs/bridge.out.log
# 本机健康检查
curl http://127.0.0.1:43111/api/v1/health        # 期望 {"status":"ok"}
# 部署自检
npm run deploy:preflight -- --data-dir <data-dir>
```

## 连接每 15 分钟左右断开一次（4401）

**症状**：App 周期性掉线，close code 4401，之后自动恢复。

**原因**：设计行为（spec §10.2/§11.1）。设备会话令牌有效期 15 分钟（`BRIDGE_DEVICE_SESSION_TTL_SECONDS`），Bridge 把每个 socket 的最长寿命限制为 Access assertion 与设备会话两者中较早的到期时间，到期**主动**以 4401 关闭；App 应先 refresh 再建立新 socket，带随机抖动的指数退避重连。

**处理**：App 自动重连则无需处理。若不恢复：连接页点"重新登录"（强制 Access refresh 后重启连接循环）；核对手机系统时间（时钟偏差会影响 token 到期判断）；仍失败则重新配对。注意 4401 的 reason 还可能是 `superseded by a new connection`（同一设备的新连接取代旧连接，正常）或 `device revoked`（见"设备撤销"条目）。

## 4410 循环（RESYNC_REQUIRED 反复出现）

**症状**：App 反复被 4410 关闭，始终进不了事件流。

**原因**：`event protocol version is incompatible; resynchronize`（两端事件协议版本不一致），或客户端状态需要走 snapshot begin/commit 重同步而 snapshot 已失效——snapshot 有 600 秒 TTL（`SNAPSHOT_TTL_MS`），过期/未知/已消费的 snapshot 会要求客户端重新 begin。

**处理**：

1. 确认 App 与 Bridge 来自同一代码版本（协议 `claude-remote.v1`）。
2. 校准手机时钟后重试。
3. 重启 Bridge 会清除遗留的 `prepared` snapshot（启动 sweep 将过期项标记为 `expired`），客户端重连后重新 begin 即可走出循环。
4. 仍循环：保留 `<data-dir>/logs/bridge.err.log` 片段与两端版本号，按 bug 上报。

## 消息卡在"结果不确定"（indeterminate）

**症状**：一条已发送的消息长期显示"结果无法确认"。

**原因**：spec §7.4/§11.2。命令在 `dispatching`/`dispatched` 状态遭遇连接断开或进程异常，恢复检查在 transcript 中找不到该用户消息 UUID（或 transcript 不可解析）时，命令保持 `indeterminate`——不猜测结果。

**处理**：

- `indeterminate` 且 App 已通过 Phase 0 去重门槛：使用"**安全重试**"（`command.retry_indeterminate`，Bridge 以原 UUID 和原 payload 重新派发，不会在 transcript 产生重复用户消息）。
- 未通过门槛或不想重试：按原 session ID 恢复会话后自行判断。
- `interrupted`（消息已送达但执行中断）**不要重发原消息**：使用"恢复会话"或发一条新的"继续"消息。Bridge 从不自动重放 `indeterminate`/`interrupted` 命令。

## 权限提示约 5 分钟后自动被拒绝

**症状**：手机上没来得及点允许，权限请求自己变成了拒绝。

**原因**：设计行为（spec §6.4/§11.5）。权限等待默认 300 秒（`DEFAULT_PERMISSION_TIMEOUT_SECONDS`）后自动 deny；手机断线时未决请求保持等待直到服务端超时。session Stop、Bridge 关闭与设备撤销也都会先拒绝未决权限。

**处理**：5 分钟内在手机处理；需要更长时限时在 Bridge 环境设置 `BRIDGE_PERMISSION_TIMEOUT_SECONDS=<秒>`（正整数）并重启 launchd job。

## Bridge 重启 / 崩溃之后

**症状**：Bridge 进程退出（崩溃或手动重启），担心会话与子进程状态。

**原因/行为**（spec §7.6，均有自动化测试）：

- launchd `KeepAlive { SuccessfulExit = false }`：崩溃自动重启；SIGTERM 优雅退出（退出码 0）则保持停止。
- 租约包装器检测控制管道关闭，按停止顺序（拒绝未决权限 → SIGINT → 5s → SIGTERM → 5s → SIGKILL）终止 Claude 进程组，**不会留下孤儿进程继续写 transcript**。
- 启动恢复：使旧 instance 锁过期、终止身份匹配的旧进程（PID 不匹配不发信号）、旧未决权限标记拒绝、`running`/`waiting_permission`/`interrupting` 会话转 `interrupted`、`dispatching`/`dispatched` 命令先转 `indeterminate` 再按 transcript 证据归类。

**处理**：通常无需操作——在 App 中按原 session ID **显式**恢复（Bridge 不会自动产生新模型请求）。怀疑残留进程时 `ps aux | grep claude` 核对，再 `npm run deploy:uninstall-launchd` + 重装走一遍预检。

## 撤销设备 / 重新配对

**症状**：手机丢失、换机，或想让新设备配对。

**命令**：

```bash
BRIDGE_DATA_DIR=<data-dir> npm run -w bridge admin -- admin list-devices
BRIDGE_DATA_DIR=<data-dir> npm run -w bridge admin -- admin revoke-device <deviceId>
BRIDGE_DATA_DIR=<data-dir> npm run -w bridge admin -- admin revoke-all-devices
```

**行为**：撤销事务标记设备并删除其全部设备会话与未使用 challenge（数据库层立即生效）；**正在运行的 Bridge** 通过 30 秒间隔的撤销轮询（`REVOCATION_POLL_INTERVAL_MS = 30_000`，`bridge/src/main.ts`）发现 `revokedAt` 行，关闭该设备 socket（4401 `device revoked`）并拒绝其未决权限。审计写入 `admin.revoke_device` / `device.revoke`。撤销后的签名即使有效也失败。

**重新配对**：首版只允许一个未撤销设备——先撤销旧设备，再 `admin pairing-qrcode`（见 [deploy.md](./deploy.md) 第 8 步）。

## 存储压力（HTTP 503 STORAGE_PRESSURE）

**症状**：App 发命令被拒，响应 `503` 且 `code=STORAGE_PRESSURE`。

**原因**：spec §11.6。某会话的未确认（pending）事件字节占用达到预算（默认 64 MiB，`BRIDGE_PENDING_EVENTS_BYTE_BUDGET`）时，Bridge 拒绝派发新命令；未确认事件无法持久化时也会暂停接收新消息并停止活动进程，避免产生无法交付的输出。未确认事件保留 600 秒（`PENDING_EVENT_RETENTION_SECONDS`）后清理。

**处理**：

1. 让设备上线正常收事件并 ACK（`events.ack` 推进每会话确认游标），积压会随之下降。
2. 停止不再使用的活动会话（显式 Stop）。
3. 检查 `<data-dir>` 所在磁盘空间。
4. 长期方案再考虑调大 `BRIDGE_PENDING_EVENTS_BYTE_BUDGET`——但先弄清楚设备为什么长时间不 ACK。

## 审计脱敏验证

**位置**：`<data-dir>/audit.jsonl`（0600；单文件 10 MiB 轮转，保留 5 份或 30 天，先到为准）。

**验证**（实现见 `bridge/src/audit/audit-log.ts`，行为有单测覆盖 `bridge/test/audit/audit-log.test.ts`）：

```bash
# 明文凭据类模式不应出现（只会以 [REDACTED:key] / [REDACTED:bearer] 形式存在）
grep -nE 'sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]+|AKIA[0-9A-Z]{16}' <data-dir>/audit.jsonl
# 应无输出。spot check 脱敏标记确实存在：
grep -c '\[REDACTED' <data-dir>/audit.jsonl
```

规则要点：`authorization`/`token`/`apikey`/`password`/`x-claude-remote-device-session` 等键的值整体替换为 `[REDACTED]`；凭据形态字符串替换为 `[REDACTED:key|bearer|aws|b64]`；`/Users/<名字>` 只抹去用户名；Access subject 只保存 SHA-256 哈希；审计**从不**保存完整 prompt、Claude 回复、工具参数/输出、stderr、OAuth/设备令牌或文件内容；**配对令牌不写审计**。

## LAN 不可达验证（tunnel-only 边界）

**症状/验证**：从同一局域网的其他设备执行：

```bash
curl -m 3 http://<Mac-内网IP>:43111/api/v1/health   # 期望：连接被拒绝或超时
curl http://127.0.0.1:43111/api/v1/health           # Mac 本机期望：{"status":"ok"}
```

**原因**：Bridge 只绑定 `127.0.0.1`（`BRIDGE_HOST` 只接受 loopback，配置层直接拒绝其他值），Cloudflare Tunnel 是唯一公网入口（spec §10.1）。局域网能访问到说明有额外暴露：检查路由器端口转发、是否有其他进程占了 43111、或机器上跑了别的转发。

## cloudflared 断开（公网不可达，本机正常）

**症状**：App 连不上 `<public-host>`（Cloudflare 边缘错误页/530），但 Mac 本机 health 正常。

**原因**：tunnel connector 进程退出或配置漂移——Bridge 与 tunnel 是两个独立进程，Bridge 无感知。

**处理**：

```bash
cloudflared tunnel info claude-remote                 # 核对 tunnel 存在与连接数
cloudflared tunnel run --config ~/.cloudflared/config.yml   # 重新拉起 connector
```

仍不通时按序核对：DNS 路由（`cloudflared tunnel route dns`）、`config.yml` 的 ingress 主机名与端口、Access 应用是否仍覆盖该域名。同时确认没人把 `originRequest`/TLS 绕过写进配置（渲染器会拒绝，手改可能绕过）。

## 4426 协议不兼容 / Upgrade 400

**症状**：连接被 4426 关闭（`subprotocol claude-remote.v1 required` / `unsupported protocol version`），或 HTTP Upgrade 直接 400。

**原因**：App 与 Bridge 的协议版本不一致，或客户端没带 `Sec-WebSocket-Protocol`。

**处理**：两端升级到同一版本；老版本 App 对上新版本 Bridge 时按 spec §8.1 在握手阶段被拒绝是预期行为。

## 4403 another device is already connected

**症状**：第二台设备无法连接，close 4403。

**原因**：首版单写入设备语义——同一时刻只允许一个设备连接/写入（新连接会取代同设备的旧连接，但不同设备被拒）。

**处理**：只在一台手机上使用；换机走"撤销设备/重新配对"。

## 409 SESSION_CONFLICT（终端与手机双写）

**症状**：命令返回 `409` + `code=SESSION_CONFLICT`。

**原因**：同一 session 被另一个客户端持有写锁——典型是你在 Mac 终端里 `claude --resume <session-id>` 后又从 App 恢复（spec §7.7）。

**处理**：按切换流程：终端里退出该会话，App 再恢复；或反过来——App 中停止活动 turn 并释放会话，终端恢复。App 会警告不要同时双写。

## 数据库损坏（维护模式）

**症状**：Bridge 启动即失败或数据库检查异常。

**原因**：spec §11.6——数据库损坏进入维护模式，只允许本地诊断和备份。

**处理**：**不要删除数据库或 transcript**。备份 `<data-dir>/bridge.db` 后人工排查；`npm run deploy:preflight -- --data-dir <data-dir>` 的 `database` 检查会给出具体错误。

## MIUI / Android 真机注意事项

- 开发者选项需同时开启 **USB 调试** 和 **USB 安装**；MIUI 上"USB 安装"可能要求联网/登录账号。
- `adb install`、instrumented 测试（在 `android/` 目录执行 `./gradlew app:connectedDebugAndroidTest`，会连装 app + test 两个 APK）都会触发手机上的**安装确认弹窗**，不手动点允许就表现为 adb 超时——真机联调"卡住"时先看手机屏幕。
- Android 9（API 28）起才支持本 App；配对密钥要求 Keystore 提供不可导出的 P-256，能力探测不满足的设备会被拒绝（spec §15）。
