# BridgeBar

macOS 菜单栏管理端 for the claude-remote Bridge（spec: docs/superpowers/specs/2026-09-15-bridge-admin-gui-design.md）。

- 开发：`swift run`（先启动 bridge，token 默认读 `~/.local/share/claude-remote/admin-api-token`）
- 测试：`swift test`
- 打包：`./scripts/make-app.sh` → 拖 `build/release/BridgeBar.app` 进 /Applications
- 设置里可改 data dir、admin 端口；开机自启走系统登录项（Settings 勾选）

## 配置说明

### 默认配置（开箱即用）

BridgeBar 默认配置与 launchd 管理的 Bridge 完全兼容：
- **数据目录**: `~/.local/share/claude-remote`
- **Admin API**: `http://127.0.0.1:43112`

无需任何手动配置即可使用。

### 故障排查

**问题：显示"Bridge 未运行"但 Bridge 正在运行**

运行配置重置脚本：
```bash
./Scripts/reset-config.sh
```
然后重启 BridgeBar。

**问题：token 不匹配**

确保数据目录配置正确：
```bash
# 检查 Bridge 使用的数据目录
cat ~/Library/LaunchAgents/dev.clauderemote.bridge.plist | grep BRIDGE_DATA_DIR

# 应该显示: ~/.local/share/claude-remote
```

如果不一致，在 BridgeBar 设置中修改数据目录路径，或运行重置脚本。

### 手动配置

只在需要自定义数据目录时才需要：

1. 修改 launchd 配置中的 `BRIDGE_DATA_DIR`
2. 重启 Bridge：`launchctl kickstart -k gui/501/dev.clauderemote.bridge`
3. 在 BridgeBar 设置中设置相同路径
4. 重启 BridgeBar

⚠️ **重要**：BridgeBar 和 Bridge 必须使用相同的数据目录，否则 token 验证会失败。
