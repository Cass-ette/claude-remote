import Foundation

struct BridgeStatus: Codable, Equatable, Sendable {
    var uptimeSeconds: Int
    var publicReachable: Bool?
    var activeSessions: Int
    var device: DeviceCard?
    var dbSizeBytes: Int
    var version: String

    struct DeviceCard: Codable, Equatable, Sendable {
        var deviceId: String
        var displayName: String
        var pairedAt: Double
        var sessionExpiresAt: Double?
    }
}

struct Project: Codable, Equatable, Identifiable, Sendable {
    var projectId: String
    var canonicalRealpath: String
    var deviceNumber: Int
    var inode: Int
    var displayName: String
    var createdAt: Double
    var authorizedAt: Double
    var id: String { projectId }
}

struct Device: Codable, Equatable, Identifiable, Sendable {
    var deviceId: String
    var displayName: String
    var accessSubject: String
    var pairedAt: Double
    var revokedAt: Double?
    var id: String { deviceId }
}

struct DeviceList: Codable, Equatable, Sendable {
    var active: Device?
    var revoked: [Device]
}

struct PairingCode: Codable, Equatable, Sendable {
    var payload: String
    var expiresAt: Double
}

struct SessionRow: Codable, Equatable, Identifiable, Sendable {
    var sessionId: String
    var displayName: String
    var status: String
    var projectDisplayName: String
    var lockedBy: String?
    var processPid: Int?
    var lastActivityAt: Double
    var createdAt: Double
    var id: String { sessionId }
}

struct AuditRow: Codable, Equatable, Identifiable, Sendable {
    var auditId: Int
    var occurredAt: Double
    var operationType: String
    var resultCode: String
    var deviceId: String?
    var sessionId: String?
    var projectId: String?
    var id: Int { auditId }
}

struct AuditPage: Codable, Equatable, Sendable {
    var items: [AuditRow]
    var nextCursor: Int?
}

struct LogTail: Codable, Equatable, Sendable {
    var content: String
}
