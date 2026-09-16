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

    /// green = bridge reachable AND tunnel up AND device session valid & not near expiry.
    /// yellow = reachable but degraded (tunnel down, device session expired/expiring < 24h, or no device paired).
    /// red = admin API unreachable. publicReachable == nil (local-only) is neutral.
    static func from(status: BridgeStatus?, bridgeReachable: Bool, nowMs: Double) -> IconState {
        guard bridgeReachable, let status else { return .red }

        // Tunnel unreachable
        if status.publicReachable == false { return .yellow }

        // Device paired but session expired or missing
        if let device = status.device {
            guard let expires = device.sessionExpiresAt else {
                // sessionExpiresAt is null = all sessions expired, need re-login
                return .yellow
            }
            // Session expiring within 24 hours
            if expires - nowMs < 24 * 3_600_000 { return .yellow }
        }

        return .green
    }
}
