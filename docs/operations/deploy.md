# Claude Remote 部署手册（Deploy Runbook）

面向第一次部署的操作者：在一台 Mac 上跑起 Bridge（launchd + Cloudflare Tunnel），在一台 Android 手机上安装 App，完成一台设备的配对并发出第一条消息。

所有命令都以仓库根目录（`claude-remote/`）为工作目录。示例约定：

| 占位符 | 含义 | 示例值 |
| --- | --- | --- |
| `<data-dir>` | Bridge 数据目录（数据库、审计日志、运行日志都在里面） | `~/.local/share/claude-remote`（安装器默认值） |
| `<public-host>` | 公网主机名（你自己 zone 里的 DNS 记录） | `bridge.example.com` |
| `<team-domain>` | Cloudflare Access 团队域 | `myteam.cloudflareaccess.com` |
| `<aud-tag>` | Access 应用的 audience tag | （创建 Access 应用后获得，见第 5 步） |

## 0. 前提条件

- **macOS**。Bridge 以 per-user LaunchAgent 方式运行（`~/Library/LaunchAgents`），不提供 Linux/systemd 部署路径，也绝不以 root 运行。
- **Node 22**（CI 使用 22）：`node --version`。
- **cloudflared**：`brew install cloudflared`（或从 Cloudflare 官网下载），`cloudflared --version` 验证。
- **一个 Cloudflare 账号**，并且有一个你能管理 DNS 的 zone（例如 `example.com`）。
- Mac 上**不需要** Android SDK；只有自己构建 APK 时才需要（第 7 步）。
- 手机：Android 9 及以上（`minSdk = 28`）。
- Mac 上已安装并能正常使用 **Claude Code CLI**（`claude`，Bridge 以当前用户身份派生子进程；可用 `BRIDGE_CLAUDE_BIN` 指定绝对路径覆盖）。

## 1. 构建 Bridge

```bash
git clone https://github.com/Cass-ette/claude-remote.git
cd claude-remote
npm ci
npm run build -w bridge
```

产物：

- `bridge/dist/src/main.js` — Bridge 入口（launchd 将以绝对 node 路径执行它）
- `bridge/dist/src/admin/cli.js` — 本地管理 CLI（`bridge admin …`）

## 2. 授权一个项目（admin CLI）

管理 CLI 与服务器共享同一个 `BRIDGE_DATA_DIR`，两者必须指向同一目录：

```bash
BRIDGE_DATA_DIR=<data-dir> \
  npm run -w bridge admin -- admin authorize-project /absolute/path/to/project "My project"
```

可用子命令（`npm run -w bridge admin -- admin <子命令>`）：

| 子命令 | 作用 |
| --- | --- |
| `authorize-project <abs-path> <name>` | 授权项目目录（必须是绝对路径，且不能是符号链接） |
| `list-projects` | 列出已授权项目 |
| `revoke-project <projectId>` | 取消授权 |
| `list-devices` / `revoke-device` / `revoke-all-devices` | 设备管理（见 troubleshooting） |
| `pairing-qrcode` | 生成配对二维码（第 8 步） |
| `preflight [--json]` | 部署自检（第 6 步） |

注意：项目白名单只控制 Claude 会话的启动工作目录，**不是文件系统沙箱**（spec §10.5）。Bridge 每次启动/恢复会话前会重新解析 realpath 并校验文件系统设备号与 inode，目录被替换或授权路径本身是符号链接时拒绝启动。

## 3. 创建 Cloudflare Tunnel 并路由 DNS

```bash
cloudflared tunnel login                                  # 浏览器里授权 zone
cloudflared tunnel create claude-remote                   # 记下输出里的 tunnel UUID
cloudflared tunnel route dns claude-remote <public-host>  # 为公网主机名建 CNAME
```

`tunnel create` 会把凭证写到 `~/.cloudflared/<tunnel-uuid>.json`（0600，不要放宽权限）。

## 4. 安装 launchd（同时写出 0600 env 文件）

安装器一次性完成：渲染 plist（0644，只含非机密 env）+ 机密 env 文件（0600）+ 日志目录（0700），并在**预检门禁通过后**才执行 `launchctl bootstrap`。

建议先 `--dry-run` 看将写入什么：

```bash
npm run deploy:install-launchd -- --dry-run \
  --data-dir <data-dir> \
  --team-domain <team-domain> \
  --aud <aud-tag> \
  --public-host <public-host>
```

正式安装（去掉 `--dry-run` 再跑一遍）：

```bash
npm run deploy:install-launchd -- \
  --data-dir <data-dir> \
  --team-domain <team-domain> \
  --aud <aud-tag> \
  --public-host <public-host>
```

`<aud-tag>` 来自第 5 步创建的 Access 应用——如果你还没有它，先做第 5 步再回来安装。

常用旗标（`npx tsx deploy/scripts/install-launchd.ts -h` 查看全部）：

- `--data-dir`（默认 `~/.local/share/claude-remote`）
- `--bridge-main`（默认本仓库的 `bridge/dist/src/main.js`）
- `--port`（默认 43111）
- `--team-domain` / `--aud` / `--public-host`：写入 0600 env 文件的三个远端访问配置；team-domain 与 aud 必须成对出现或成对缺省
- `--config <path>`：改用 env 风格配置文件提供上述键（`BRIDGE_DATA_DIR`、`BRIDGE_MAIN`、`BRIDGE_NODE_BIN`、`BRIDGE_PORT`、`BRIDGE_CLOUDFLARE_TEAM_DOMAIN`、`BRIDGE_CLOUDFLARE_AUD`、`BRIDGE_PUBLIC_HOST`）
- `--dry-run`、`--skip-preflight`（仅开发用途）

安装器写入的文件：

| 文件 | 模式 | 内容 |
| --- | --- | --- |
| `~/Library/LaunchAgents/dev.clauderemote.bridge.plist` | 0644 | 绝对 node 路径 + `bridge/dist/src/main.js`；内联 `BRIDGE_DATA_DIR` / `BRIDGE_HOST=127.0.0.1` / `BRIDGE_PORT` / `BRIDGE_ENV_FILE` |
| `~/Library/LaunchAgents/dev.clauderemote.bridge.env` | 0600 | `BRIDGE_CLOUDFLARE_TEAM_DOMAIN`、`BRIDGE_CLOUDFLARE_AUD`、`BRIDGE_PUBLIC_HOST`（Bridge 启动时经 `BRIDGE_ENV_FILE` 加载） |
| `<data-dir>/logs/bridge.out.log`、`bridge.err.log` | 0600 | launchd 标准输出/错误 |

KeepAlive 语义：`SuccessfulExit = false`——崩溃（非零退出）自动重启；`launchctl bootout` 的正常停止保持停止。plist 永远不包含 cloudflared：tunnel connector 是独立进程（第 5 步末尾）。

停止与卸载（数据目录保留，不删除数据库/审计）：

```bash
npm run deploy:uninstall-launchd
```

## 5. 渲染 cloudflared 配置并创建 Access 应用

先把 tunnel 信息追加进第 4 步生成的同一个 env 文件：

```bash
cat >> ~/Library/LaunchAgents/dev.clauderemote.bridge.env <<'EOF'
CF_TUNNEL_ID=<tunnel-uuid>
CF_TUNNEL_CREDENTIALS_FILE=/absolute/path/to/.cloudflared/<tunnel-uuid>.json
CF_ACCESS_SUBJECTS=owner@example.com
# 可选但建议：固定只允许 One-time PIN 邮箱 IdP
# CF_ACCESS_EMAIL_IDP=<one-time-pin-idp-id>
EOF
chmod 600 ~/Library/LaunchAgents/dev.clauderemote.bridge.env
```

渲染（默认就读上面这个 env 文件；也可用 `--tunnel-id` / `--credentials-file` / `--public-host` / `--aud` / `--subjects` / `--email-idp` 显式覆盖）：

```bash
npm run deploy:render-cloudflared
```

输出（0600，默认 `~/.cloudflared/`）：

- `config.yml` — cloudflared tunnel 配置。**恰好一个** ingress 主机名 → `http://127.0.0.1:<port>`，末尾 `http_status:404` 兜底；渲染器拒绝第二个主机名、`http://` scheme、service-token 风格输入、任何空变量。
- `access-app.json` — Access 应用示例，变量已填充。

创建/核对 Access 应用（Zero Trust → Access → Applications）：

1. 新建 **Self-hosted** 应用，domain 填 `<public-host>`。创建后在应用详情里能看到 **aud tag**——把它回填到 env 文件的 `BRIDGE_CLOUDFLARE_AUD` 与第 4 步安装参数（保持一致），并重跑一次 `npm run deploy:render-cloudflared` 让 `access-app.json` 的 `aud` 与实际应用一致。
2. 按 `~/.cloudflared/access-app.json` 核对/填写其余字段：
   - `app_launcher_visible: false`
   - bypass 恰好五条（修订 spec §10.2）：exact-path `/.well-known/assetlinks.json`、`/.well-known/oauth-authorization-server`、`/auth/registration`、`/auth/token`，以及 path 前缀 `/api/v1`。**`/auth/authorize` 不 bypass**——它是邮箱 OTP 登录门，必须留在 Access 之后；`/api/v1/*` 的认证由 Bridge 在 origin 校验同一 Access JWT（Bearer 回退），边缘 bypass 不降低安全性
   - 唯一 policy：`allow`，include 只列 `CF_ACCESS_SUBJECTS` 里的邮箱（owner only）
   - `allowed_idps` 仅 One-time PIN（设置了 `CF_ACCESS_EMAIL_IDP` 时）
3. 或者直接走 API：`PUT https://api.cloudflare.com/client/v4/zones/<zone-id>/access/apps/<app-id>`，body 即渲染出的 `access-app.json`。

最后，运行 tunnel connector。调试阶段可以前台手动跑：

```bash
cloudflared tunnel run --config ~/.cloudflared/config.yml
```

长期运行用**独立**的用户级 LaunchAgent（与 Bridge 的 launchd 互不管理，绝不并入 Bridge 的 plist；也不需要 root 的 `cloudflared service install`）：

```bash
npm run deploy:install-tunnel-launchd        # 装好后 RunAtLoad 自启 + 崩溃自动拉起
npm run deploy:uninstall-tunnel-launchd      # 卸载（tunnel/config/凭据/日志均保留）
```

安装器会预检（cloudflared 可执行、config.yml 含 `tunnel:` + `credentials-file:`、凭据可读），只写 `~/Library/LaunchAgents/dev.clauderemote.cloudflared.plist`，日志落在 `<data-dir>/logs/cloudflared.{out,err}.log`。注意：手动前台的 connector 与 LaunchAgent 的 connector 可以并存（同一 tunnel 多 connector 官方支持），验证 agent 正常后停掉手动的那个即可。

## 6. 预检（Preflight）

```bash
# 可选：开启 Cloudflare 侧检查（三者必须同时提供）
export CF_API_TOKEN=<api-token>
export CF_ZONE_ID=<zone-id>
export CF_EXPECTED_SUBJECT=owner@example.com
# 可选：开启 tunnel 存在性检查
export BRIDGE_CLOUDFLARE_TUNNEL_NAME=claude-remote

npm run deploy:preflight -- --data-dir <data-dir>
```

逐项输出 `PASS` / `FAIL` / `INFO`（INFO = 该项未配置而跳过，不会导致失败）。检查项：

| 检查名 | 验证内容 |
| --- | --- |
| `loopback-bind` | `BRIDGE_HOST` 是 loopback、`BRIDGE_DATA_DIR` 为绝对路径 |
| `data-dir` | 数据目录权限 0700 且属主是当前用户 |
| `database` | `bridge.db` 可打开并干净迁移 |
| `audit-log` | `audit.jsonl` 可打开（0600、轮转） |
| `cloudflare-jwks` | `https://<team-domain>/cdn-cgi/access/certs` 可达（未配置 team domain 时 INFO） |
| `plist-path` | `BRIDGE_PLIST_PATH` 严格位于 `~/Library/LaunchAgents` 内 |
| `cloudflared-tunnel` | `cloudflared tunnel info <name>` 退出码 0（未配置名称时 INFO） |
| `access-policy-subject` | zone 内该 aud 的 Access 应用策略覆盖期望 subject（三元组未配置时 INFO） |
| `bridge-health` | 以 `BRIDGE_PREFLIGHT_HEALTH_ONLY=1` 拉起 built entry，loopback `GET /api/v1/health` 返回 `{"status":"ok"}` 且度过占用端口宽限窗 |
| `tunnel-only` | 说明性检查：Bridge 只绑 loopback，公网暴露只能来自外部 tunnel |

`deploy:install-launchd` 在写入任何文件之前会自动运行同一套检查（内部以 `admin preflight --json` 拉起）。**任何一项 FAIL，安装器拒绝写入与 bootstrap——fail closed，不存在"带病上线"。**

## 6.5 运行时体检（Doctor）

```bash
npm run deploy:doctor
```

检查**此刻**的运行态（preflight 检查的是安装前配置，doctor 检查的是活着没有）：bridge / cloudflared 两个 LaunchAgent 的 `launchctl print` 状态、loopback 与公网 `GET /api/v1/health`、系统睡眠设置、自动登录。任何 FAIL 退出码 1。睡眠与自动登录只能由用户在系统设置里改（无 sudo 改不了 `pmset`），脚本只负责标 WARN。

### Fail-closed 排查清单（每个 FAIL 的对策）

| 失败项 | 原因与对策 |
| --- | --- |
| `loopback-bind` | `BRIDGE_HOST` 不是 `127.0.0.1`/`::1`，或 `BRIDGE_DATA_DIR` 缺失/非绝对路径。修正 env——不要尝试绑非 loopback，Bridge 在配置层永久拒绝（spec §5）。报告 `fatal` 时后续检查被跳过，先修配置再重跑。 |
| `data-dir` | 权限非 0700：`chmod 700 <data-dir>`；属主不是当前用户：`chown -R` 修正。预检只报告、绝不代改。 |
| `database` | `bridge.db` 打不开或迁移失败：检查磁盘与文件权限；数据库损坏进入维护模式（spec §11.6）——先备份再人工诊断，**不要删除数据库或 transcript**。 |
| `audit-log` | `audit.jsonl` 无法打开：检查目录可写与 0600 权限、磁盘是否满。 |
| `cloudflare-jwks` | team domain 与 aud 必须成对设置（只设其一即 FAIL）；`/cdn-cgi/access/certs` 不可达时核对 team domain 拼写与出网。 |
| `plist-path` | `BRIDGE_PLIST_PATH` 位于 `~/Library/LaunchAgents` 之外（例如 `/Library/LaunchDaemons`）。使用安装器默认位置；本系统永不以 root 运行。 |
| `cloudflared-tunnel` | `cloudflared` 未安装（spawn ENOENT）：`brew install cloudflared`；`tunnel info` 非零退出：先 `cloudflared tunnel login`，核对 `BRIDGE_CLOUDFLARE_TUNNEL_NAME` 与第 3 步创建的名称。 |
| `access-policy-subject` | `CF_API_TOKEN`/`CF_ZONE_ID`/`CF_EXPECTED_SUBJECT` 必须同时设置；zone 内找不到该 aud 的应用：核对 `BRIDGE_CLOUDFLARE_AUD`；策略不含该 subject：回第 5 步修正 Access policy。 |
| `bridge-health` | 无 built entry：回第 1 步 `npm run build -w bridge`；"another process … answered"：端口被旧 launchd job 或其他进程占用——`npm run deploy:uninstall-launchd`（或 `launchctl bootout gui/$(id -u)/dev.clauderemote.bridge`）后重试；子进程提前退出：看 FAIL 详情里的 child stderr 摘要。 |
| `tunnel-only` | 恒为 PASS 的说明项。 |

## 6.6 Admin API（本机管理接口）

Bridge 在启动时会在 loopback（`127.0.0.1`）上额外监听一个管理端口，默认 **43112**，可通过 `BRIDGE_ADMIN_PORT` 环境变量配置。该端口**永远只绑定 loopback，绝不经 Cloudflare Tunnel 暴露**——仅供同一台 Mac 上的本地工具使用。

首次启动时，Bridge 会在 `<data-dir>/admin-api-token` 生成随机令牌（0600 权限），客户端通过 `Authorization: Bearer <token>` 认证。删除该文件即可轮转令牌——Bridge 下次启动时重新生成，已连接的 GUI 客户端会被锁定，需重新读取新令牌。

Admin API 由 **BridgeBar** 菜单栏应用消费（见 `macos/BridgeBar/README.md`），用于实时查询 Bridge 运行状态、会话列表、设备管理等操作，无需通过公网 tunnel。

launchd plist 无需为 Admin API 添加额外配置——默认值已足够，只有需要更换端口时才显式设置 `BRIDGE_ADMIN_PORT`。

## 7. 安装 Android App

构建并安装 debug APK（`bridgeAppLinkHost` 把 OAuth 回调 App Link 的 host 烧进 manifest，autoVerify 必需）：

```bash
cd android && ./gradlew app:assembleDebug -PbridgeAppLinkHost=<public-host> && cd ..
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

- `applicationId` 为 `dev.clauderemote.android`，`minSdk 28` / `targetSdk 34`。不传 `-PbridgeAppLinkHost` 时默认占位域名 `bridge.example.com`——真实部署必须显式传入。
- debug APK 使用 debug keystore 签名；**release 签名是后续工作**（见 spec §16），发布前请勿分发 debug APK。

App Link 验证需要 Bridge 服务 `/.well-known/assetlinks.json`，而该路由**仅在配置了 APK 证书指纹时注册**。取 debug keystore 的 SHA-256 指纹并写入 env 文件，然后重启 Bridge：

```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android | grep "SHA256:"
# 形如 5B:54:BC:...:C1C（冒号可有可无）

echo 'BRIDGE_ASSETLINKS_FINGERPRINT=<sha256 指纹>' >> ~/Library/LaunchAgents/dev.clauderemote.bridge.env
chmod 600 ~/Library/LaunchAgents/dev.clauderemote.bridge.env
launchctl bootout gui/$(id -u)/dev.clauderemote.bridge 2>/dev/null; \
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.clauderemote.bridge.plist

curl -s http://127.0.0.1:43111/.well-known/assetlinks.json   # 应返回 JSON 且 target SHA-256 匹配
adb shell pm verify-app-links --re-verify dev.clauderemote.android
adb shell pm get-app-links dev.clauderemote.android          # host 应显示 verified
```

- App 首次使用前需要在连接页保存 Bridge 主机名（`<public-host>`）。

### 真机（尤其 MIUI）注意事项

- 开发者选项里需开启 **USB 调试** 与 **USB 安装**。MIUI 的"USB 安装"开关通常还要求设备联网/登录账号，视系统版本而定。
- `adb install` 与 instrumented 测试（在 `android/` 目录执行 `./gradlew app:connectedDebugAndroidTest`，会同时装 app + test 两个 APK）在 MIUI 上都会弹**安装确认弹窗**，必须手动在手机上点允许，否则 adb 侧表现为超时失败——这是真机联调时最常见的"卡住"原因。

## 8. 配对一台设备

在 Mac 上生成配对二维码（token 五分钟有效、单次使用；数据库只存其哈希）：

```bash
BRIDGE_DATA_DIR=<data-dir> \
BRIDGE_PUBLIC_HOST=<public-host> \
  npm run -w bridge admin -- admin pairing-qrcode
```

输出包含 `host:` / `token:` / `expires:` 与终端二维码，payload 形如：

```text
claude-remote://pair?host=<public-host>&token=<token>
```

手机端流程（修订 spec §10.2/§10.3）：

1. App 连接页完成登录：App 经 `/.well-known/oauth-authorization-server` 发现元数据、`/auth/registration` 动态注册 public client，然后浏览器 Custom Tab 打开 `/auth/authorize`——该路径在 Access 之后，**在这里输入邮箱收到的 One-time PIN**（只允许 `CF_ACCESS_SUBJECTS` 里的身份），通过后 Bridge 302 回 App Link，App 以 PKCE verifier 换取令牌。Bridge 本身就是 OAuth 授权服务器（修订 §10.2），Access 只是身份门。
2. 连接页点 **配对**，输入上面 `token:` 后面的配对令牌（首版为手动输入对话框；相机扫二维码为后续版本候选）。设备在 Keystore 生成不可导出的 P-256 密钥，提交 `publicKeySpki` 与 `deviceId`，Bridge 原子消费 token 并把设备绑定到当前 Access subject。
3. 之后每次连接走 challenge → ECDSA 签名 → 15 分钟设备会话。

首版**只允许一个未撤销设备**：换手机前先 `admin revoke-device <deviceId>`（或 `revoke-all-devices`），再生成新配对令牌。

实现状态：登录（发现/注册/PKCE/refresh）、手动配对与 `POST /api/v1/auth/pair|challenge|verify` 均已实现并有测试；真机端到端验收由 `RUN_E2E=1` 环境承担（需先按第 5 步配好五条 bypass，否则 discovery/registration/token 与 `/api/v1` 都会被 Access 边缘拦截）。

## 9. 第一个会话

1. 确认第 2 步已授权目标项目（App 只能提交 `projectId`，不能提交路径）。
2. App 连接页确认 Bridge/认证状态正常，进入会话页 **新建会话**，选择项目。
3. 发送第一条消息。Claude Code 的权限请求会推到手机，**默认 5 分钟不处理自动拒绝**（`BRIDGE_PERMISSION_TIMEOUT_SECONDS` 可调）。
4. 验证 tunnel-only 边界（建议）：从同一局域网另一台设备执行 `curl -m 3 http://<Mac 内网IP>:43111/api/v1/health`，应连接被拒绝/超时；Mac 本机 `curl http://127.0.0.1:43111/api/v1/health` 应返回 `{"status":"ok"}`。

遇到问题查 [troubleshooting.md](./troubleshooting.md)。
