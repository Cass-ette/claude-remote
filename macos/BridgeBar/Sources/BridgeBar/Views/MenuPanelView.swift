import SwiftUI

struct MenuPanelView: View {
    @Environment(StatusStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @State private var showPairing = false
    @State private var confirmRevoke = false
    @State private var busy = false

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 10) {
            statusCard
            errorHelpCard
            Divider()
            Button { showPairing = true } label: { Label("配对新设备", systemImage: "qrcode") }
            Button(role: .destructive) { confirmRevoke = true } label: {
                Label(store.status?.device == nil ? "撤销设备（无设备）" : "撤销此设备", systemImage: "iphone.slash")
            }
            .disabled(store.status?.device == nil || busy)
            Divider()
            Button { openWindow(id: "main") } label: { Label("打开管理窗口", systemImage: "macwindow") }
            SettingsLink { Label("设置…", systemImage: "gearshape") }
            Divider()
            Button(role: .destructive) { NSApplication.shared.terminate(nil) } label: {
                Label("退出 BridgeBar", systemImage: "power")
            }
        }
        .padding(12)
        .frame(width: 280)
        .onAppear { store.fastPolling = true }
        .onDisappear { store.fastPolling = false }
        .sheet(isPresented: $showPairing) { PairingSheet() }
        .confirmationDialog("撤销后手机会立即断开，需要重新扫码配对", isPresented: $confirmRevoke, titleVisibility: .visible) {
            Button("撤销设备", role: .destructive) {
                guard let deviceId = store.status?.device?.deviceId else { return }
                busy = true
                Task {
                    defer { busy = false }
                    try? await store.withClient { try await $0.revokeDevice(deviceId) }
                }
            }
        }
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: store.icon.symbolName)
                Text(store.bridgeReachable ? "Bridge 在线" : "Bridge 未运行").bold()
                Spacer()
                Text("v\(store.status?.version ?? "?")").font(.caption).foregroundStyle(.secondary)
            }
            if let s = store.status {
                row("运行时长", Self.duration(s.uptimeSeconds))
                row("隧道", s.publicReachable == nil ? "本机模式" : (s.publicReachable! ? "可达" : "不可达"))
                row("活跃会话", "\(s.activeSessions)")
                if let device = s.device {
                    row("设备", device.displayName + " · " + Self.expiryText(device.sessionExpiresAt))
                }

                // 隧道不可达提示
                if let reachable = s.publicReachable, !reachable {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("隧道不可达", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.orange)
                        Text("手机无法通过公网连接到 Bridge")
                            .font(.caption2).foregroundStyle(.secondary)
                        Text("→ 检查公网隧道是否正常运行")
                            .font(.caption2).foregroundStyle(.secondary)
                        Text("→ 或在 launchd env 文件中检查公网地址配置")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(8)
                    .background(Color.orange.opacity(0.1))
                    .cornerRadius(6)
                }
            }
            if !store.bridgeReachable {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Bridge 未运行", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption).foregroundStyle(.red)
                    Text("尝试运行以下命令启动：")
                        .font(.caption2).foregroundStyle(.secondary)
                    HStack(spacing: 4) {
                        Text(Self.startBridgeCommand)
                            .font(.system(.caption2, design: .monospaced))
                            .lineLimit(1).truncationMode(.middle)
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(Self.startBridgeCommand, forType: .string)
                        } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.borderless)
                    }
                }
                .padding(8)
                .background(Color.red.opacity(0.1))
                .cornerRadius(6)
            }
        }
    }

    private func row(_ key: String, _ value: String) -> some View {
        HStack { Text(key); Spacer(); Text(value).foregroundStyle(.secondary) }.font(.caption)
    }

    private func message(for error: AdminError) -> String {
        switch error {
        case .unreachable(let why): "连不上 admin API：\(why)"
        case .unauthorized: "配置问题"
        case .api(let code, let message): "[\(code)] \(message)"
        }
    }

    @ViewBuilder
    private var errorHelpCard: some View {
        if let error = store.lastError {
            switch error {
            case .unauthorized:
                VStack(alignment: .leading, spacing: 4) {
                    Label("token 不匹配", systemImage: "key.slash.fill")
                        .font(.caption).foregroundStyle(.orange)
                    Text("BridgeBar 无法读取 admin token")
                        .font(.caption2).foregroundStyle(.secondary)
                    Button("点击重置配置") {
                        store.dataDirPath = NSHomeDirectory() + "/.local/share/claude-remote"
                        store.baseURLString = "http://127.0.0.1:43112"
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(.orange)
                }
                .padding(8)
                .background(Color.orange.opacity(0.1))
                .cornerRadius(6)
            case .unreachable:
                VStack(alignment: .leading, spacing: 4) {
                    Label("无法连接 Admin API", systemImage: "network.slash")
                        .font(.caption).foregroundStyle(.orange)
                    Text("检查 Bridge 是否运行或端口是否正确")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                .padding(8)
                .background(Color.orange.opacity(0.1))
                .cornerRadius(6)
            default:
                EmptyView()
            }
        }
    }

    static func duration(_ seconds: Int) -> String {
        let d = seconds / 86400, h = seconds % 86400 / 3600, m = seconds % 3600 / 60
        if d > 0 { return "\(d)天\(h)时" }
        if h > 0 { return "\(h)时\(m)分" }
        return "\(m)分"
    }

    /// Spec §7: show the restart command, never execute it.
    static let startBridgeCommand = "launchctl kickstart -k gui/501/dev.clauderemote.bridge"

    static func expiryText(_ expiresAtMs: Double?) -> String {
        guard let ms = expiresAtMs else { return "无会话" }
        let remainSeconds = Int((ms - Date.now.timeIntervalSince1970 * 1000) / 1000)
        if remainSeconds <= 0 { return "已过期" }
        if remainSeconds < 3600 { return "会话 \(remainSeconds / 60) 分钟后过期" }
        return "会话 \(remainSeconds / 3600) 小时后过期"
    }
}
