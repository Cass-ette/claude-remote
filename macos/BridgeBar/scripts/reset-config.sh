#!/bin/bash
# BridgeBar 配置重置脚本
# 用于解决数据目录配置不一致的问题

set -e

echo "🔧 重置 BridgeBar 配置..."

# 清空所有自定义配置，使用默认值
defaults delete ai.clauderemote.bridgebar 2>/dev/null || true

echo "✅ 配置已重置为默认值"
echo ""
echo "默认配置："
echo "  数据目录: ~/.local/share/claude-remote"
echo "  Admin API: http://127.0.0.1:43112"
echo ""
echo "现在重启 BridgeBar 以应用更改"
