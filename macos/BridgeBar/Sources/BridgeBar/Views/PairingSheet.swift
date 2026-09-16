import CoreImage.CIFilterBuiltins
import SwiftUI

struct PairingSheet: View {
    @Environment(StatusStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var code: PairingCode?
    @State private var error: AdminError?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 14) {
            Text("配对新设备").font(.headline)
            if let code {
                if let image = Self.qrImage(for: code.payload) {
                    Image(nsImage: image).interpolation(.none)
                        .resizable().frame(width: 220, height: 220)
                }
                Text("有效期至 \(Self.time(code.expiresAt))").font(.caption).foregroundStyle(.secondary)
            } else if let error {
                errorView(error)
            } else {
                ProgressView().controlSize(.large)
            }
            Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction)
        }
        .padding(18)
        .frame(width: 300)
        .task { if code == nil && error == nil { fetch() } }
    }

    private func fetch() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do { code = try await store.withClient { try await $0.pairingQRCode() } }
            catch let e as AdminError { error = e }
        }
    }

    @ViewBuilder
    private func errorView(_ error: AdminError) -> some View {
        switch error {
        case .api(let code, _) where code == "already_paired":
            VStack(spacing: 8) {
                Text("已有设备配对。撤销旧设备并重新配对？").font(.callout)
                Button("撤销并出码", role: .destructive) {
                    Task {
                        try? await store.withClient { try await $0.revokeAllDevices() }
                        fetch()
                    }
                }
            }
        case .api(let code, _) where code == "public_host_unset":
            // Spec §7: dedicated hint, no retry button — the precondition is on
            // the operator side (set BRIDGE_PUBLIC_HOST, restart bridge).
            Text("Bridge 未设置公网地址：设置 BRIDGE_PUBLIC_HOST 并重启 bridge 后再出码")
                .font(.callout).multilineTextAlignment(.center)
        case .api(let code, let message):
            VStack(spacing: 8) {
                Text("[\(code)] \(message)").font(.callout)
                Button("重试") { fetch() }
            }
        default:
            VStack(spacing: 8) {
                Text("无法出码：\(error)").font(.callout)
                Button("重试") { fetch() }
            }
        }
    }

    private static func time(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        return date.formatted(date: .omitted, time: .shortened)
    }

    /// System QR generator — no third-party dependency.
    static func qrImage(for string: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}
