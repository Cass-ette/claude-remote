# BridgeBar

macOS 菜单栏管理端 for the claude-remote Bridge（spec: docs/superpowers/specs/2026-09-15-bridge-admin-gui-design.md）。

- 开发：`swift run`（先启动 bridge，token 默认读 `~/.local/share/claude-remote/admin-api-token`）
- 测试：`swift test`
- 打包：`./scripts/make-app.sh` → 拖 `build/release/BridgeBar.app` 进 /Applications
- 设置里可改 data dir、admin 端口；开机自启走系统登录项（Settings 勾选）
