import SwiftUI

// MARK: - Projects

struct ProjectsTab: View {
    @Environment(StatusStore.self) private var store
    @State private var projects: [Project] = []
    @State private var errorText: String?
    @State private var showPicker = false
    @State private var pickedURL: URL?
    @State private var projectName = ""
    @State private var confirmDelete: Project?

    var body: some View {
        Table(projects) {
            TableColumn("名称") { Text($0.displayName) }
            TableColumn("路径") { Text($0.canonicalRealpath).font(.system(.caption, design: .monospaced)) }
            TableColumn("授权于") { Text(Self.date($0.authorizedAt)) }
            TableColumn("操作") { project in
                Button("撤销授权", role: .destructive) { confirmDelete = project }
                    .buttonStyle(.borderless)
            }
        }
        .overlay { if projects.isEmpty { ContentUnavailableView("暂无授权项目", systemImage: "folder") } }
        .safeAreaInset(edge: .bottom) {
            HStack {
                TextField("项目名称", text: $projectName).frame(width: 160)
                Button("选择目录…") { showPicker = true }
                Button("授权") { authorize() }
                    .disabled(pickedURL == nil || projectName.trimmingCharacters(in: .whitespaces).isEmpty)
                Spacer()
            }
            .padding(8)
        }
        .alert("操作失败", isPresented: .init(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
            Button("好") {}
        } message: { Text(errorText ?? "") }
        .confirmationDialog(
            "撤销「\(confirmDelete?.displayName ?? "")」的授权？",
            isPresented: .init(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("撤销授权", role: .destructive) {
                guard let project = confirmDelete else { return }
                Task {
                    do {
                        try await store.withClient { try await $0.deleteProject(project.projectId) }
                        reload()
                    } catch { errorText = "\(error)" }
                }
            }
        }
        .sheet(isPresented: $showPicker) {
            NSOpenPanelView { url in pickedURL = url }
        }
        .task { reload() }
    }

    private func reload() {
        Task {
            do { projects = try await store.withClient { try await $0.projects() } }
            catch { errorText = "\(error)" }
        }
    }

    private func authorize() {
        guard let url = pickedURL else { return }
        Task {
            do {
                _ = try await store.withClient { try await $0.authorizeProject(path: url.path, name: projectName) }
                pickedURL = nil; projectName = ""
                reload()
            } catch { errorText = "\(error)" }
        }
    }

    static func date(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}

/// NSOpenPanel wrapped for SwiftUI (directory chooser).
private struct NSOpenPanelView: View {
    @Environment(\.dismiss) private var dismiss
    let onPick: (URL?) -> Void

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .task {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true
                panel.canChooseFiles = false
                if panel.runModal() == .OK { onPick(panel.url) } else { onPick(nil) }
                dismiss()
            }
    }
}

// MARK: - Devices

struct DevicesTab: View {
    @Environment(StatusStore.self) private var store
    @State private var devices = DeviceList(active: nil, revoked: [])
    @State private var errorText: String?
    @State private var confirmRevoke = false

    var body: some View {
        List {
            if let active = devices.active {
                Section("当前设备") {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(active.displayName).bold()
                            Text("配对于 \(ProjectsTab.date(active.pairedAt))").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("撤销", role: .destructive) { confirmRevoke = true }
                    }
                }
            } else {
                ContentUnavailableView("无配对设备", systemImage: "iphone.slash")
            }
            if !devices.revoked.isEmpty {
                Section("已撤销") {
                    ForEach(devices.revoked) { device in
                        VStack(alignment: .leading) {
                            Text(device.displayName).strikethrough()
                            Text("撤销于 \(ProjectsTab.date(device.revokedAt ?? 0))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .alert("操作失败", isPresented: .init(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
            Button("好") {}
        } message: { Text(errorText ?? "") }
        .confirmationDialog("撤销后手机会立即断开，需要重新扫码配对", isPresented: $confirmRevoke, titleVisibility: .visible) {
            Button("撤销设备", role: .destructive) {
                guard let id = devices.active?.deviceId else { return }
                Task {
                    do { try await store.withClient { try await $0.revokeDevice(id) }; reload() }
                    catch { errorText = "\(error)" }
                }
            }
        }
        .task { reload() }
    }

    private func reload() {
        Task {
            do { devices = try await store.withClient { try await $0.devices() } }
            catch { errorText = "\(error)" }
        }
    }
}

// MARK: - Sessions (read-only)

struct SessionsTab: View {
    @Environment(StatusStore.self) private var store
    @State private var sessions: [SessionRow] = []

    var body: some View {
        Table(sessions) {
            TableColumn("会话") { Text($0.displayName) }
            TableColumn("项目") { Text($0.projectDisplayName) }
            TableColumn("状态") { row in
                Text(row.status).foregroundStyle(row.status == "running" ? Color.green : Color.secondary)
            }
            TableColumn("锁") { row in Text(row.lockedBy ?? "—").font(.caption) }
            TableColumn("最近活动") { Text(ProjectsTab.date($0.lastActivityAt)) }
        }
        .overlay { if sessions.isEmpty { ContentUnavailableView("暂无会话", systemImage: "terminal") } }
        .refreshable { reload() }
        .task { reload() }
    }

    private func reload() {
        Task { sessions = (try? await store.withClient { try await $0.sessions() }) ?? sessions }
    }
}

// MARK: - Audit

struct AuditTab: View {
    @Environment(StatusStore.self) private var store
    @State private var rows: [AuditRow] = []
    @State private var nextCursor: Int?

    var body: some View {
        Table(rows) {
            TableColumn("时间") { Text(ProjectsTab.date($0.occurredAt)) }.width(min: 120, ideal: 150)
            TableColumn("操作") { Text($0.operationType) }
            TableColumn("结果") { row in
                Text(row.resultCode).foregroundStyle(row.resultCode == "ok" ? Color.green : Color.orange)
            }
            TableColumn("设备") { Text($0.deviceId ?? "—").font(.caption) }
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                Spacer()
                if nextCursor != nil {
                    Button("加载更多") { loadMore() }
                } else {
                    Text("没有更多了").font(.caption).foregroundStyle(.secondary)
                }
            }.padding(6)
        }
        .task { if rows.isEmpty { loadMore() } }
    }

    private func loadMore() {
        Task {
            guard let page = try? await store.withClient({ try await $0.audit(limit: 50, cursor: nextCursor) }) else { return }
            rows += page.items
            nextCursor = page.nextCursor
        }
    }
}

// MARK: - Logs

struct LogsTab: View {
    @Environment(StatusStore.self) private var store
    @State private var file = "out"
    @State private var content = ""
    @State private var paused = false

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $file) {
                Text("stdout").tag("out"); Text("stderr").tag("err")
            }
            .pickerStyle(.segmented).frame(width: 160).padding(8)
            HStack {
                Button(paused ? "继续" : "暂停") { paused.toggle() }
                Spacer()
                Text("\(content.utf16.count) 字符").font(.caption).foregroundStyle(.secondary)
            }.padding(.horizontal, 12)
            ScrollViewReader { proxy in
                ScrollView {
                    Text(content.isEmpty ? "（空）" : content)
                        .font(.system(size: 11, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .id("bottom")
                }
                .onChange(of: content) { _, _ in
                    if !paused { proxy.scrollTo("bottom") }
                }
            }
        }
        .task(id: file) {
            while !Task.isCancelled {
                if !paused, let tail = try? await store.withClient({ try await $0.logTail(file: file, bytes: 32_768) }) {
                    content = tail.content
                }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
}
