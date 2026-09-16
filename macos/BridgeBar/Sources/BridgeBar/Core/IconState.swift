import Foundation

enum IconState: Equatable, Sendable {
    case green, yellow, red

    var symbolName: String {
        switch self {
        case .green: "checkmark.circle.fill"
        case .yellow: "exclamationmark.triangle.fill"
        case .red: "xmark.octagon.fill"
        }
    }

    /// green = bridge reachable AND tunnel up AND device session not near expiry.
    /// yellow = reachable but degraded (tunnel down, or device session < 24h).
    /// red = admin API unreachable. publicReachable == nil (local-only) is neutral.
    static func from(status: BridgeStatus?, bridgeReachable: Bool, nowMs: Double) -> IconState {
        guard bridgeReachable, let status else { return .red }
        if status.publicReachable == false { return .yellow }
        if let expires = status.device?.sessionExpiresAt, expires - nowMs < 24 * 3_600_000 { return .yellow }
        return .green
    }
}
