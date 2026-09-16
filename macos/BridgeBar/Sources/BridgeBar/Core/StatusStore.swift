import Foundation
import Observation
import SwiftUI

/// Owns the admin endpoint config (UserDefaults-backed) and the /status poll.
/// The panel sets `fastPolling` on appear/disappear: 5s while open, 30s idle.
@MainActor @Observable
final class StatusStore {
    private(set) var status: BridgeStatus?
    private(set) var lastError: AdminError?
    private(set) var endpoint: AdminEndpoint?
    private(set) var bridgeReachable = false

    var fastPolling = false {
        didSet { scheduleNext(immediate: true) }
    }

    private var backoff = Backoff()
    private var pollTask: Task<Void, Never>?
    private var client: AdminClient?

    // UserDefaults-backed settings
    var dataDirPath: String {
        didSet { persistAndReload() }
    }
    var baseURLString: String {
        didSet { persistAndReload() }
    }

    init(defaults: UserDefaults = .standard) {
        dataDirPath = defaults.string(forKey: "dataDirPath") ?? NSHomeDirectory() + "/.local/share/claude-remote"
        baseURLString = defaults.string(forKey: "baseURLString") ?? "http://127.0.0.1:43112"
        self.defaults = defaults
        reloadEndpoint()
        startPolling()
    }

    private let defaults: UserDefaults

    var icon: IconState {
        IconState.from(status: status, bridgeReachable: bridgeReachable, nowMs: Date.now.timeIntervalSince1970 * 1000)
    }

    var pollInterval: TimeInterval {
        bridgeReachable ? (fastPolling ? 5 : 30) : backoff.delay
    }

    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                let delay = self?.pollInterval ?? 30
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }

    private func tick() async {
        guard let client else {
            lastError = .unreachable("token file not found — check the data dir in Settings")
            bridgeReachable = false
            return
        }
        do {
            let fresh = try await client.status()
            status = fresh
            bridgeReachable = true
            lastError = nil
            backoff.recordSuccess()
        } catch let error as AdminError {
            lastError = error
            bridgeReachable = false
            backoff.recordFailure()
        } catch {
            lastError = .unreachable(error.localizedDescription)
            bridgeReachable = false
            backoff.recordFailure()
        }
    }

    /// One-shot helpers the views use for non-status routes; errors surface via `lastError`.
    func withClient<T>(_ body: @Sendable (AdminClient) async throws -> T) async throws -> T {
        guard let client else { throw AdminError.unreachable("token file not found — check the data dir in Settings") }
        return try await body(client)
    }

    private func scheduleNext(immediate: Bool) {
        // The run loop picks the new interval up on the next sleep; immediate
        // re-tick keeps the panel snappy when it opens.
        if immediate { pollTask?.cancel(); pollTask = nil; startPolling() }
    }

    private func persistAndReload() {
        defaults.set(dataDirPath, forKey: "dataDirPath")
        defaults.set(baseURLString, forKey: "baseURLString")
        reloadEndpoint()
    }

    private func reloadEndpoint() {
        guard let url = URL(string: baseURLString),
              let loaded = AdminClient.loadEndpoint(dataDirPath: dataDirPath, baseURL: url) else {
            endpoint = nil
            client = nil
            return
        }
        endpoint = loaded
        client = AdminClient(endpoint: loaded)
    }
}
