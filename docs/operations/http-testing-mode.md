# HTTP 测试模式配置指南

**用于无域名场景的 HTTP 明文通信测试。生产环境请使用 HTTPS + Cloudflare Access。**

## 问题背景

标准部署要求：
- HTTPS + 域名
- Cloudflare Tunnel + Access
- Android App Links (需要域名验证)

无域名测试场景需要：
- HTTP 明文通信（开发/测试）
- 直连 IP:Port
- Custom URL Scheme 替代 App Links

## 核心修改

### 1. Bridge 配置

**关键：`BRIDGE_PUBLIC_HOST` 不能包含端口号**

```bash
# ❌ 错误 - 会导致 challenge 签名失败
BRIDGE_PUBLIC_HOST=8.147.59.78:8888

# ✅ 正确
BRIDGE_PUBLIC_HOST=8.147.59.78
BRIDGE_PUBLIC_SCHEME=http
```

启动 Bridge：

```bash
cd bridge
BRIDGE_DATA_DIR=/Users/你的用户名/.claude-remote/bridge \
BRIDGE_PUBLIC_HOST=你的IP \
BRIDGE_PUBLIC_SCHEME=http \
node dist/src/main.js
```

### 2. Android 网络安全配置

**文件：** `android/app/src/main/res/xml/network_security_config.xml`

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- 生产环境：仅 HTTPS -->
    <base-config cleartextTrafficPermitted="false" />
    
    <!-- 测试模式：允许指定 IP 的明文流量 -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">你的测试IP</domain>
    </domain-config>
</network-security-config>
```

### 3. OAuth 重定向配置

Bridge 的 OAuth 服务器已支持 HTTP 重定向 URI：

**文件：** `bridge/src/auth/oauth-server.ts` (line ~119)

```typescript
// 允许 HTTP 用于测试（生产环境移除此条件）
if (parsed.protocol !== "https:" && 
    parsed.protocol !== "http:" && 
    parsed.protocol !== "claude-remote:") {
  return "redirect_uri_must_use_https_or_custom_scheme";
}
```

### 4. Android Manifest 配置

添加 Custom URL Scheme 用于 OAuth 回调：

**文件：** `android/app/src/main/AndroidManifest.xml`

```xml
<activity
    android:name=".ui.MainActivity"
    android:launchMode="singleTask">
    
    <!-- 原有的 App Links (HTTPS) -->
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https"
              android:host="你的域名"
              android:path="/auth/callback" />
    </intent-filter>
    
    <!-- HTTP 测试：Custom URL Scheme -->
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="claude-remote"
              android:host="callback" />
    </intent-filter>
</activity>
```

### 5. PairingController 修改

**文件：** `android/.../auth/PairingController.kt` (line ~148-151)

移除 `runCatching`，让 device session 建立失败时正确抛出异常：

```kotlin
// ❌ 原代码 - 吞掉异常
runCatching { graph.deviceSessions.getValidDeviceSessionToken() }

// ✅ 修正后 - 正确抛出异常
try {
    graph.deviceSessions.getValidDeviceSessionToken()
} catch (e: Exception) {
    throw PairingFlowException(
        "设备配对成功，但无法建立会话（challenge/verify 失败）",
        e,
    )
}
```

### 6. SSH 反向隧道（可选）

如果 Bridge 运行在本地，需要通过公网 IP 访问：

```bash
# Mac 本地 Bridge (127.0.0.1:43111) → 公网服务器 (8.147.59.78:8888)
ssh -R 43200:localhost:43111 root@8.147.59.78 -N &

# 公网服务器上配置端口转发（nginx/其他）
# 8888 → 127.0.0.1:43200
```

## 已知问题和解决方案

### 问题 1: Challenge 返回 500 错误

**错误日志：**
```
InvalidHostException: bare host must not contain URL delimiters: "8.147.59.78:8888"
```

**原因：** `BRIDGE_PUBLIC_HOST` 包含了端口号，但 `normalizeHost` 函数不接受端口。

**解决：** 移除端口号，只保留 IP 或域名：
```bash
BRIDGE_PUBLIC_HOST=8.147.59.78  # ✅
```

### 问题 2: WebSocket 连接无法建立

**症状：**
- OAuth 登录成功
- 设备配对成功
- 但"进入会话"按钮禁用（灰色）
- Bridge 日志无 WebSocket 连接记录

**原因：** Device session 建立失败（challenge/verify），但 `runCatching` 吞掉了异常，coordinator 启动时没有有效的 device session token。

**解决：** 按上述第 5 点修改 `PairingController.kt`。

### 问题 3: "进入会话"按钮一直禁用

**原因：** `ConnectionState` 未达到 `CONNECTED` 状态。

**诊断步骤：**
1. 检查 Bridge 是否运行：`ps aux | grep "node.*main.js"`
2. 检查 SSH 隧道（如使用）：`ps aux | grep "ssh.*43200"`
3. 查看 Bridge 日志：`tail -f /tmp/bridge.log`
4. 查看 Android logcat：`adb logcat -s "ConnectionCoordinator:V"`

**预期日志流程：**
```
POST /api/v1/auth/challenge → 200
POST /api/v1/auth/verify → 200
GET /api/v1/ws → WebSocket Upgrade
```

## 安全警告

⚠️ **HTTP 测试模式不适合生产环境：**

1. **无加密**：所有流量明文传输（OAuth tokens、设备密钥签名、消息内容）
2. **无 Cloudflare Access**：缺少外层认证保护
3. **IP 直连**：暴露真实服务器地址

**生产环境必须使用：**
- HTTPS（TLS 1.3）
- 有效域名 + 证书
- Cloudflare Tunnel + Access
- App Links 验证

## 测试验证

成功配置后的验证清单：

- [ ] Bridge 启动成功（监听 127.0.0.1:43111）
- [ ] SSH 隧道建立（如使用）
- [ ] Android 应用安装成功
- [ ] OAuth 登录流程完成（浏览器跳转回应用）
- [ ] 设备配对成功（显示 deviceId）
- [ ] WebSocket 连接建立（Bridge 日志显示 `/api/v1/ws`）
- [ ] 会话列表显示（"进入会话"按钮可点击）
- [ ] 消息收发正常
- [ ] 深色主题正确显示

## 恢复到生产模式

1. 移除 `network_security_config.xml` 中的测试 IP
2. 恢复 `BRIDGE_PUBLIC_SCHEME=https`
3. 设置正确的域名 `BRIDGE_PUBLIC_HOST=your-domain.com`
4. 启用 Cloudflare Tunnel
5. 移除 Custom URL Scheme intent-filter（保留 App Links）
6. 重新编译并签名发布版 APK
