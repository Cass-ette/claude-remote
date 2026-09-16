import Foundation
import Testing
@testable import BridgeBar

@Test func errorMapping() async throws {
    // 401 → unauthorized
    #expect(AdminClient.error(fromStatus: 401, data: Data()) == .unauthorized)
    // API error body → .api(code,message)
    let body = try JSONEncoder().encode(["error": ["code": "already_paired", "message": "a device is already paired"]])
    #expect(
        AdminClient.error(fromStatus: 409, data: body)
            == .api(code: "already_paired", message: "a device is already paired")
    )
    // Malformed body on non-2xx → generic api error carrying the status
    if case let .api(code, _) = AdminClient.error(fromStatus: 500, data: Data("nope".utf8)) {
        #expect(code == "http_500")
    } else {
        Issue.record("expected generic api error")
    }
}

@Test func endpointLoadReadsTokenFile() throws {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("bb-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let tokenPath = dir.appendingPathComponent("admin-api-token")
    try Data("tok123\n".utf8).write(to: tokenPath)

    let endpoint = AdminClient.loadEndpoint(dataDirPath: dir.path, baseURL: URL(string: "http://127.0.0.1:43112")!)
    #expect(endpoint?.token == "tok123")
    #expect(endpoint?.baseURL.absoluteString == "http://127.0.0.1:43112")

    try? FileManager.default.removeItem(at: dir)
}

@Test func decodeStatus() throws {
    let json = """
    {"uptimeSeconds":42,"publicReachable":false,"activeSessions":1,
     "device":{"deviceId":"d","displayName":"Phone","pairedAt":0,"sessionExpiresAt":99},
     "dbSizeBytes":1024,"version":"0.1.0"}
    """
    let status = try JSONDecoder().decode(BridgeStatus.self, from: Data(json.utf8))
    #expect(status.device?.sessionExpiresAt == 99)
    #expect(status.publicReachable == false)
}
