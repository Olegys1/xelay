import Foundation
import WidgetKit

private struct APIProblem: Error {
    let status: Int
    let code: String
    let accountGate: Bool
}

/// A fresh, cookie-free URLSession per bounded request. Redirects are rejected;
/// neither credentials nor private responses are written to URLCache or logs.
private final class BoundedRequest: NSObject, URLSessionDataDelegate {
    private let semaphore = DispatchSemaphore(value: 0)
    private var received = Data()
    private var response: HTTPURLResponse?
    private var failure: Error?
    private let maximum = 512 * 1024
    func send(_ request: URLRequest) throws -> (Data, Int) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCache = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 15
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.dataTask(with: request); task.resume()
        guard semaphore.wait(timeout: .now() + 16) == .success else {
            task.cancel(); session.invalidateAndCancel(); throw XelayError.network
        }
        session.finishTasksAndInvalidate()
        if failure != nil { throw XelayError.network }
        guard let response else { throw XelayError.network }
        return (received, response.statusCode)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.expectedContentLength <= maximum else {
            failure = XelayError.invalidResponse; completionHandler(.cancel); return
        }
        self.response = response; completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard received.count + data.count <= maximum else { failure = XelayError.invalidResponse; dataTask.cancel(); return }
        received.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { failure = error }; semaphore.signal()
    }
}

final class XelayClient {
    private let configuration: AppConfiguration
    private let store: SharedStore
    private static let terminalSessionCodes: Set<String> = ["refresh_token_not_found", "refresh_token_already_used", "refresh_token_expired", "session_not_found", "session_expired", "user_not_found", "user_banned"]
    init() throws { let config = try AppConfiguration(); configuration = config; store = try SharedStore(configuration: config) }

    private func background<T>(_ action: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .utility).async { continuation.resume(with: Result { try action() }) }
        }
    }
    func account() async throws -> Account? { try await background { try self.store.locked { try $0.session()?.account } } }
    func resetLocalData() async throws {
        defer { WidgetCenter.shared.reloadAllTimelines() }
        try await background { try self.store.resetLocalData() }
    }
    func identity() async throws -> SessionIdentity? {
        try await background { try self.store.locked { access in
            try access.session().map { SessionIdentity(epoch: $0.epoch, accountID: $0.account.id, cacheEpoch: access.state.cacheEpoch) }
        } }
    }
    func groupsWereTruncated() async throws -> Bool { try await background { try self.store.locked { $0.state.groupsTruncated } } }
    func cachedGroups() async throws -> [GroupChoice] {
        try await background { try self.store.locked { access in
            guard let session = try access.session(), let date = access.state.groupsUpdatedAt,
                  Date().timeIntervalSince(date) >= -90, Date().timeIntervalSince(date) < 6 * 3600 else { return [] }
            return access.state.groups.filter { $0.accountID == session.account.id }
        } }
    }
    func cachedSnapshot(for choice: GroupChoice) async throws -> WidgetSnapshot? {
        try await background { try self.store.locked { access in
            guard let session = try access.session(), session.account.id == choice.accountID else { return nil }
            return access.state.snapshots[choice.group.id.uuidString.lowercased()].flatMap { $0.isFresh(at: Date()) ? $0 : nil }
        } }
    }

    func signIn(email: String, password: String) async throws {
        try await background {
            guard !email.isEmpty, email.count <= 320, !password.isEmpty, password.count <= 4096 else { throw XelayError.invalidCredentials }
            let expected = try self.store.locked { $0.state.epoch }
            let raw: Data
            do { raw = try self.request(path: "/auth/v1/token", query: "grant_type=password", body: ["email": email, "password": password]) }
            catch let problem as APIProblem {
                if problem.code == "email_not_confirmed" { throw XelayError.emailUnconfirmed }
                if problem.code == "user_banned" { throw XelayError.accountUnavailable }
                if ["captcha_failed", "insufficient_aal", "mfa_verification_failed"].contains(problem.code) { throw XelayError.verificationRequired }
                if problem.status == 429 { throw XelayError.rateLimited }
                if ["invalid_credentials", "invalid_grant"].contains(problem.code) { throw XelayError.invalidCredentials }
                throw XelayError.api(status: problem.status, code: problem.code)
            }
            let epoch = UUID(), session = try self.authSession(raw, epoch: epoch)
            try self.store.locked { access in
                guard access.state.epoch == expected else { throw XelayError.sessionChanged }
                access.state = SharedState(); access.state.epoch = epoch; try access.save()
                try access.writeSession(session)
                access.state.accountID = session.account.id; try access.save()
            }
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
    func signOut() async throws {
        defer { WidgetCenter.shared.reloadAllTimelines() }
        // Forget locally first. Failure/offline revocation cannot leave personal
        // content visible; local-scope revoke never signs out the website.
        let old: StoredSession? = try await background { try self.store.locked { access in
            let old = try? access.session(); try access.clearSession(); return old
        } }
        WidgetCenter.shared.reloadAllTimelines()
        if let old { _ = try? await background { try self.request(path: "/auth/v1/logout", query: "scope=local", body: [:], token: old.accessToken) } }
    }

    func groups() async throws -> [GroupChoice] {
        try await background {
            let (raw, ticket) = try self.rpc("xelay_android_widget_groups", body: [:], groupID: nil)
            struct Envelope: Decodable { let groups: [AcademicGroup]; let truncated: Bool }
            guard let value = try? WireJSON.decoder().decode(Envelope.self, from: raw), value.groups.count <= 50,
                  Set(value.groups.map(\.id)).count == value.groups.count else { throw XelayError.invalidResponse }
            try value.groups.forEach { try $0.validate() }
            let groups = value.groups.map { GroupChoice(accountID: ticket.account.id, group: $0) }
            try self.store.locked { access in
                try access.require(ticket)
                let previousIDs = Set(access.state.groups.map { $0.group.id })
                let currentIDs = Set(groups.map { $0.group.id })
                if !value.truncated, previousIDs != currentIDs { access.state.cacheEpoch = UUID() }
                access.state.groups = groups; access.state.groupsUpdatedAt = Date()
                access.state.groupsTruncated = value.truncated
                let ids = Set(groups.map { $0.group.id.uuidString.lowercased() })
                if !value.truncated { access.state.snapshots = access.state.snapshots.filter { ids.contains($0.key) } }
                try access.save()
            }; return groups
        }
    }
    func snapshot(for choice: GroupChoice) async throws -> WidgetSnapshot {
        try await background {
            let (raw, ticket) = try self.rpc("xelay_android_widget_snapshot", body: ["p_group_id": choice.group.id.uuidString.lowercased()], groupID: choice.group.id, expectedAccount: choice.accountID)
            let value: WidgetSnapshot
            do { value = try WireJSON.decoder().decode(WidgetSnapshot.self, from: raw); try value.validate(expectedGroup: choice.group.id) }
            catch { throw XelayError.invalidResponse }
            let selected = try self.store.locked { access -> WidgetSnapshot in
                try access.require(ticket)
                let key = choice.group.id.uuidString.lowercased()
                if access.state.snapshots[key].map({ $0.generatedAt <= value.generatedAt }) ?? true {
                    // A bounded LRU-like cap also applies to configurations saved
                    // before a group disappears from a truncated groups response.
                    if access.state.snapshots[key] == nil, access.state.snapshots.count >= 50,
                       let oldest = access.state.snapshots.min(by: { $0.value.generatedAt < $1.value.generatedAt })?.key {
                        access.state.snapshots.removeValue(forKey: oldest)
                    }
                    access.state.snapshots[key] = value; try access.save()
                }
                return access.state.snapshots[key] ?? value
            }; return selected
        }
    }

    /// Refresh token rotation is serialized across the app and the extension.
    /// Ordinary data requests run outside flock, then compare epoch before save.
    private func activeSession(forceRefresh: Bool = false, rejectedToken: String? = nil, expectedAccount: UUID? = nil) throws -> StoredSession {
        try store.locked { access in
            guard let session = try access.session() else { throw XelayError.signedOut }
            if let expectedAccount, session.account.id != expectedAccount { throw XelayError.sessionChanged }
            if session.expiresAt > Date().addingTimeInterval(60), (!forceRefresh || (rejectedToken != nil && session.accessToken != rejectedToken)) { return session }
            let raw: Data
            do { raw = try request(path: "/auth/v1/token", query: "grant_type=refresh_token", body: ["refresh_token": session.refreshToken]) }
            catch let problem as APIProblem {
                if [400, 401, 403].contains(problem.status), Self.terminalSessionCodes.contains(problem.code) {
                    defer { WidgetCenter.shared.reloadAllTimelines() }
                    try access.clearSession(); throw XelayError.sessionExpired
                }
                if problem.status == 429 { throw XelayError.rateLimited }
                throw XelayError.api(status: problem.status, code: problem.code)
            }
            let refreshed = try authSession(raw, epoch: session.epoch)
            guard refreshed.account.id == session.account.id else { throw XelayError.invalidResponse }
            // Do not restore the old refresh token if readback fails: Supabase
            // may already have consumed it and the new record must remain saved.
            try access.writeSession(refreshed); return refreshed
        }
    }
    private func rpc(_ name: String, body: [String: Any], groupID: UUID?, expectedAccount: UUID? = nil) throws -> (Data, RequestTicket) {
        let initial = try activeSession(expectedAccount: expectedAccount)
        var ticket = try store.locked { access -> RequestTicket in
            try access.require(initial)
            let requestID = name == "xelay_android_widget_groups" ? UUID() : nil
            if let requestID { access.state.latestGroupsRequestID = requestID; try access.save() }
            return RequestTicket(session: initial, cacheEpoch: access.state.cacheEpoch, groupsRequestID: requestID)
        }
        do {
            let raw: Data
            do { raw = try request(path: "/rest/v1/rpc/" + name, body: body, token: ticket.session.accessToken) }
            catch let problem as APIProblem where problem.status == 401 && !problem.accountGate {
                ticket.session = try activeSession(forceRefresh: true, rejectedToken: ticket.session.accessToken, expectedAccount: ticket.account.id)
                try store.locked { try $0.require(ticket) }
                raw = try request(path: "/rest/v1/rpc/" + name, body: body, token: ticket.session.accessToken)
            }
            try store.locked { try $0.require(ticket) }; return (raw, ticket)
        } catch let problem as APIProblem {
            if problem.accountGate || problem.status == 403 {
                try store.locked { access in try access.require(ticket.session); try access.evict(groupID: problem.accountGate ? nil : groupID) }
                WidgetCenter.shared.reloadAllTimelines()
                throw problem.accountGate ? XelayError.accountUnavailable : XelayError.membershipRequired
            }
            if problem.status == 429 { throw XelayError.rateLimited }
            // A data 401 alone is never evidence that a refresh token is revoked.
            throw XelayError.api(status: problem.status, code: problem.code)
        }
    }
    private func request(path: String, query: String? = nil, body: [String: Any], token: String? = nil) throws -> Data {
        guard path.hasPrefix("/auth/v1/") || ["/rest/v1/rpc/xelay_android_widget_groups", "/rest/v1/rpc/xelay_android_widget_snapshot"].contains(path) else { throw XelayError.configuration }
        var components = URLComponents(url: configuration.supabaseURL, resolvingAgainstBaseURL: false)!
        components.path = path; components.percentEncodedQuery = query
        guard let url = components.url else { throw XelayError.configuration }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 15
        request.setValue(configuration.anonymousKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, status) = try BoundedRequest().send(request)
        guard (200..<300).contains(status) else {
            let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let code = (value?["code"] as? String) ?? (value?["error_code"] as? String) ?? ""
            let message = (value?["message"] as? String) ?? ""
            throw APIProblem(status: status, code: code.count <= 100 ? code : "", accountGate: code == "28000" || message == "AUTH_REQUIRED")
        }; return data
    }
    private func authSession(_ data: Data, epoch: UUID) throws -> StoredSession {
        struct User: Decodable { let id: UUID; let email: String? }
        struct Auth: Decodable {
            let access_token: String; let refresh_token: String; let expires_in: Double; let expires_at: Double?; let user: User
        }
        guard let value = try? JSONDecoder().decode(Auth.self, from: data), !value.access_token.isEmpty, value.access_token.count <= 16384,
              !value.refresh_token.isEmpty, value.refresh_token.count <= 16384, value.expires_in > 0, value.expires_in <= 7 * 86400 else { throw XelayError.invalidResponse }
        let expiry = value.expires_at.map { Date(timeIntervalSince1970: $0) } ?? Date().addingTimeInterval(value.expires_in)
        guard expiry > Date(), expiry < Date().addingTimeInterval(7 * 86400) else { throw XelayError.invalidResponse }
        return StoredSession(epoch: epoch, account: Account(id: value.user.id, email: value.user.email ?? ""), accessToken: value.access_token,
                             refreshToken: value.refresh_token, expiresAt: expiry)
    }
}
