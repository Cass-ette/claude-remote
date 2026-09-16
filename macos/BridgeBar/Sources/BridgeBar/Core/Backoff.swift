import Foundation

/// Exponential backoff for failed polls: 1s → 2s → 4s → … capped at 60s.
struct Backoff: Equatable, Sendable {
    private(set) var failures: Int = 0
    static let base: TimeInterval = 1
    static let cap: TimeInterval = 60

    var delay: TimeInterval { min(Self.base * pow(2, Double(failures)), Self.cap) }

    mutating func recordFailure() { failures += 1 }
    mutating func recordSuccess() { failures = 0 }
}
