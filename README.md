# Claude Remote

**用 Android 手机远程驱动 Mac 上的 Claude Code。** Remote-control Claude Code sessions on your Mac from an Android phone.

[![CI](https://github.com/Cass-ette/claude-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/Cass-ette/claude-remote/actions/workflows/ci.yml)

手机上可以：新建/恢复会话、收发消息、查看流式输出与工具调用卡片、批准或拒绝工具权限请求。Mac 上的 Claude Code 进程、transcript 与全部凭据都不离开本机。

## 仓库状态

| 指标 | 数值 |
| --- | --- |
| Node 测试（vitest，bridge + deploy + probes） | 667 通过 / 2 自动跳过（真实环境门槛用例，无凭据时 skip）/ 0 失败 |
| Android JVM 单元测试 | 158 通过 / 0 失败 |
| Android instrumented 测试类 | 6 个（需真机/模拟器，不在 CI 中运行） |
| CI | 确定性检查：typecheck + 全部测试 + bridge 构建 + phase0 聚合器 + Android JVM 测试与 assembleDebug（见 `.github/workflows/ci.yml`；真实 Claude/Cloudflare/设备门槛永不在 CI 调用） |

本地复跑：

```bash
npm test
npm run typecheck
npm run build -w bridge
cd android && ./gradlew app:testDebugUnitTest app:assembleDebug
```

## 安全模型（摘要）

- **Bridge 只绑 loopback**（`127.0.0.1`/`::1`，配置层直接拒绝其他值），Cloudflare Tunnel 是唯一公网入口；不配置路由器端口转发。停掉 tunnel 即从公网消失。
- **两层认证**：外层 Cloudflare Access Managed OAuth（Authorization Code + PKCE，策略只允许 owner 身份）；内层设备密钥认证——配对时设备在 Android Keystore 生成不可导出的 P-256 密钥，每次连接完成 challenge → ECDSA 签名，换取 15 分钟设备会话 token。Bridge 校验 Access JWT 的签名/iss/aud/sub/exp，且 subject 必须与配对记录一致。
- **单设备**：首版只允许一个未撤销的已配对设备；撤销在 30 秒内生效并关闭其活动连接。
- **没有 shell/文件端点**：Bridge API 不提供任意 Shell、文件读取/下载或进程启动接口；App 只能提交 `projectId`，项目白名单只控制工作目录（不是文件系统沙箱，spec §10.5）。
- **审计**：本地 0600 JSONL 审计日志，10 MiB 轮转；不记录 prompt、回复、工具参数/输出或任何令牌，错误字符串入库前脱敏。

完整威胁模型与边界见 spec §10（公网安全）与 §15（已知风险）。

## 目录结构

```
bridge/     Mac 端 Node.js 服务：HTTP/WebSocket、会话监督、权限代理、审计、admin CLI
android/    Android App（Kotlin + Compose，minSdk 28）
contracts/  两端共享的协议契约
probes/     Phase 0 真实环境探针（Claude Code / transcript / Cloudflare）
deploy/     launchd 安装器、预检、cloudflared/Access 配置渲染
docs/       设计规格、实施计划、运维手册
```

## 部署与运维

- 部署手册（安装 Bridge、Cloudflare Tunnel + Access、launchd、配对设备）：[docs/operations/deploy.md](docs/operations/deploy.md)
- 故障排查（连接断开、4410 循环、indeterminate 命令、撤销、存储压力等）：[docs/operations/troubleshooting.md](docs/operations/troubleshooting.md)

## 文档

- 设计规格：[docs/superpowers/specs/2026-08-02-claude-remote-android-design.md](docs/superpowers/specs/2026-08-02-claude-remote-android-design.md)
- 实施计划：[docs/superpowers/plans/2026-08-03-claude-remote-android-implementation.md](docs/superpowers/plans/2026-08-03-claude-remote-android-implementation.md)

## 已知限制（spec §15/§16 摘要）

- `--permission-prompt-tool` 的 JSON 契约未进入 Claude Code 公开文档，兼容范围靠 Phase 0 探针与固定版本保护。
- 普通终端仍可绕过 Bridge 锁直接 `claude --resume` 同一 session，只能靠流程警告降低并发写入风险。
- 设备会话令牌是短期 bearer token，不提供逐请求防重放（逐请求签名/DPoP 列为后续版本）。
- Android release 签名与 App 内扫码配对 UI 属于后续工作；真机端到端验收由 instrumented 测试与 `RUN_E2E=1` 环境承担。
- 首版不承诺多会话性能指标；大工具输出靠截断与存储背压控制。

## 无担保声明

本项目按"现状"提供，**不附带任何明示或默示担保**，包括但不限于适销性、特定用途适用性及不侵权。这是一个实验性的个人项目：安全模型经过设计与测试，但未经第三方审计。自行部署所产生的风险由部署者承担。
