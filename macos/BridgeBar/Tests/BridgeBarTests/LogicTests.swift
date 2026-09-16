import Foundation
import Testing
@testable import BridgeBar

@Test func backoffDoublesAndCaps() {
    var backoff = Backoff()
    #expect(backoff.delay == 1)
    backoff.recordFailure() // 1 failure → 2s
    #expect(backoff.delay == 2)
    backoff.recordFailure(); backoff.recordFailure() // 3 failures → 8s
    #expect(backoff.delay == 8)
    for _ in 0..<20 { backoff.recordFailure() }
    #expect(backoff.delay == 60) // capped
    backoff.recordSuccess()
    #expect(backoff.delay == 1)
}

@Test func iconStates() {
    let nowMs = 1_000_000.0
    let ok = BridgeStatus(uptimeSeconds: 1, publicReachable: true, activeSessions: 0, device: nil, dbSizeBytes: 0, version: "0")
    #expect(IconState.from(status: ok, bridgeReachable: true, nowMs: nowMs) == .green)
    // bridge down → red regardless of last status
    #expect(IconState.from(status: ok, bridgeReachable: false, nowMs: nowMs) == .red)
    // tunnel down → yellow
    let tunnelDown = BridgeStatus(uptimeSeconds: 1, publicReachable: false, activeSessions: 0, device: nil, dbSizeBytes: 0, version: "0")
    #expect(IconState.from(status: tunnelDown, bridgeReachable: true, nowMs: nowMs) == .yellow)
    // publicReachable nil (local-only) is neutral, not yellow
    let local = BridgeStatus(uptimeSeconds: 1, publicReachable: nil, activeSessions: 0, device: nil, dbSizeBytes: 0, version: "0")
    #expect(IconState.from(status: local, bridgeReachable: true, nowMs: nowMs) == .green)
    // device session expiring within 24h → yellow
    let soon = BridgeStatus(uptimeSeconds: 1, publicReachable: true, activeSessions: 0,
                            device: .init(deviceId: "d", displayName: "P", pairedAt: 0, sessionExpiresAt: nowMs + 3_600_000),
                            dbSizeBytes: 0, version: "0")
    #expect(IconState.from(status: soon, bridgeReachable: true, nowMs: nowMs) == .yellow)
    let far = BridgeStatus(uptimeSeconds: 1, publicReachable: true, activeSessions: 0,
                           device: .init(deviceId: "d", displayName: "P", pairedAt: 0, sessionExpiresAt: nowMs + 7 * 86_400_000),
                           dbSizeBytes: 0, version: "0")
    #expect(IconState.from(status: far, bridgeReachable: true, nowMs: nowMs) == .green)
    #expect(IconState.red.symbolName == "xmark.octagon.fill")
}
