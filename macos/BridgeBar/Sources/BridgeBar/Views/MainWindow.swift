import SwiftUI

struct MainWindow: View {
    var body: some View {
        TabView {
            ProjectsTab().tabItem { Label("项目", systemImage: "folder.badge.gearshape") }
            DevicesTab().tabItem { Label("设备", systemImage: "iphone") }
            SessionsTab().tabItem { Label("会话", systemImage: "terminal") }
            AuditTab().tabItem { Label("审计", systemImage: "list.bullet.rectangle") }
            LogsTab().tabItem { Label("日志", systemImage: "doc.text") }
        }
        .frame(minWidth: 640, minHeight: 420)
    }
}
