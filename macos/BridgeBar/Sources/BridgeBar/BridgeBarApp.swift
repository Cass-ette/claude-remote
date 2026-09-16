import SwiftUI

@main
struct BridgeBarApp: App {
    @State private var store = StatusStore()

    var body: some Scene {
        MenuBarExtra {
            MenuPanelView()
                .environment(store)
        } label: {
            Image(systemName: store.icon.symbolName)
        }
        .menuBarExtraStyle(.window)

        Window("Bridge 管理", id: "main") {
            MainWindow()
                .environment(store)
        }
        .defaultSize(width: 720, height: 480)

        Settings {
            SettingsView()
                .environment(store)
        }
    }
}
