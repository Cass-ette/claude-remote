import Foundation

enum AdminError: Error, Equatable, Sendable {
    case unreachable(String)
    case unauthorized
    case api(code: String, message: String)
}

struct AdminEndpoint: Equatable, Sendable {
    var baseURL: URL
    var token: String
}

/// The ONLY networking code in the app. An actor so token/endpoint swaps are
/// race-free; all responses are decoded into AdminModels value types.
actor AdminClient {
    private var endpoint: AdminEndpoint
    private let session: URLSession

    init(endpoint: AdminEndpoint, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.session = session
    }

    func updateEndpoint(_ newEndpoint: AdminEndpoint) {
        endpoint = newEndpoint
    }

    /// Resolve the endpoint the same way the bridge writes it: token file at
    /// `<dataDir>/admin-api-token`. Returns nil when the file is missing.
    nonisolated static func loadEndpoint(dataDirPath: String, baseURL: URL) -> AdminEndpoint? {
        guard let raw = try? String(contentsOfFile: dataDirPath + "/admin-api-token", encoding: .utf8) else { return nil }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : AdminEndpoint(baseURL: baseURL, token: token)
    }

    // MARK: - Typed API

    func status() async throws -> BridgeStatus { try await get("status") }
    func projects() async throws -> [Project] { try await get("projects") }
    func devices() async throws -> DeviceList { try await get("devices") }
    func sessions() async throws -> [SessionRow] { try await get("sessions") }
    func audit(limit: Int, cursor: Int?) async throws -> AuditPage {
        try await get("audit?limit=\(limit)\(cursor.map { "&cursor=\($0)" } ?? "")")
    }
    func logTail(file: String, bytes: Int) async throws -> LogTail {
        try await get("logs/tail?file=\(file)&bytes=\(bytes)")
    }

    func authorizeProject(path: String, name: String) async throws -> Project {
        try await post("projects", body: ["path": path, "name": name])
    }

    func deleteProject(_ projectId: String) async throws {
        try await expectEmpty("projects/\(projectId)", method: "DELETE")
    }

    func revokeDevice(_ deviceId: String) async throws {
        try await expectEmpty("devices/\(deviceId)/revoke", method: "POST")
    }

    func revokeAllDevices() async throws {
        try await expectEmpty("devices/revoke-all", method: "POST")
    }

    func pairingQRCode() async throws -> PairingCode {
        try await postEmpty("pairing/qrcode")
    }

    // MARK: - Transport

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await decode(request(for: path))
    }

    private func postEmpty<T: Decodable>(_ path: String) async throws -> T {
        var request = request(for: path)
        request.httpMethod = "POST"
        return try await decode(request)
    }

    private func post<T: Decodable>(_ path: String, body: some Encodable & Sendable) async throws -> T {
        var request = request(for: path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        return try await decode(request)
    }

    private func expectEmpty(_ path: String, method: String) async throws {
        var request = request(for: path)
        request.httpMethod = method
        let (_, response) = try await send(request)
        try check(response: response, data: Data())
    }

    private func request(for path: String) -> URLRequest {
        // URL(string:) leaves an existing query string intact; appendingPathComponent would escape "?".
        guard let url = URL(string: endpoint.baseURL.absoluteString + "/admin/v1/" + path) else {
            preconditionFailure("invalid admin URL for path \(path)")
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10
        return request
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw AdminError.unreachable("non-HTTP response")
            }
            return (data, http)
        } catch let error as AdminError {
            throw error
        } catch {
            throw AdminError.unreachable(error.localizedDescription)
        }
    }

    private func decode<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await send(request)
        try check(response: response, data: data)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw AdminError.unreachable("malformed response: \(error.localizedDescription)")
        }
    }

    private func check(response: HTTPURLResponse, data: Data) throws {
        guard !(200...299).contains(response.statusCode) else { return }
        throw Self.error(fromStatus: response.statusCode, data: data)
    }

    /// Pure error normalization — tested directly.
    nonisolated static func error(fromStatus status: Int, data: Data) -> AdminError {
        if status == 401 { return .unauthorized }
        struct ErrorBody: Decodable {
            struct Inner: Decodable { var code: String; var message: String }
            var error: Inner
        }
        if let parsed = try? JSONDecoder().decode(ErrorBody.self, from: data) {
            return .api(code: parsed.error.code, message: parsed.error.message)
        }
        return .api(code: "http_\(status)", message: "request failed with HTTP \(status)")
    }
}

/// Type-erasing box so one transport can encode any body type.
private struct AnyEncodable: Encodable {
    private let encodeFunc: (Encoder) throws -> Void
    init(_ wrapped: some Encodable) { encodeFunc = { try wrapped.encode(to: $0) } }
    func encode(to encoder: Encoder) throws { try encodeFunc(encoder) }
}
