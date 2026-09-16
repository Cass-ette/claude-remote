import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @Environment(StatusStore.self) private var store
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginItemError: String?

    var body: some View {
        @Bindable var store = store
        Form {
            Section("连接") {
                TextField("Data 目录", text: $store.dataDirPath)
                TextField("Admin 地址", text: $store.baseURLString)
                LabeledContent("Token 状态") {
                    if store.endpoint != nil {
                        Label("已读取", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        Label("未找到 admin-api-token", systemImage: "xmark.circle.fill").foregroundStyle(.red)
                    }
                }
            }
            Section("登录项") {
                Toggle("开机自动启动", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, on in
                        do {
                            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                            loginItemError = nil
                        } catch { loginItemError = "\(error)" }
                    }
                if let loginItemError {
                    Text(loginItemError).font(.caption).foregroundStyle(.red)
                }
                Text("`swift run` 的裸进程无法注册登录项；用 make-app.sh 打包后从 /Applications 运行再开启。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 420)
    }
}
