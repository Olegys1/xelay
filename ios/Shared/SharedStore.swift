import Foundation
import Security
import Darwin

struct StoredSession: Codable, Equatable {
    let epoch: UUID
    let account: Account
    let accessToken: String
    let refreshToken: String
    let expiresAt: Date
}
struct RequestTicket {
    var session: StoredSession
    let cacheEpoch: UUID
    let groupsRequestID: UUID?
    var account: Account { session.account }
}

struct SharedState: Codable {
    var epoch = UUID()
    var cacheEpoch = UUID()
    var latestGroupsRequestID: UUID?
    var accountID: UUID?
    var groups: [GroupChoice] = []
    var groupsUpdatedAt: Date?
    var groupsTruncated = false
    var snapshots: [String: WidgetSnapshot] = [:]
}

/// Only the token record is in Keychain. The bounded private cache is in the
/// sandboxed App Group, protected until first unlock and excluded from backup.
/// One stable flock file coordinates BOTH processes, including refresh rotation.
final class SharedStore {
    private static let queue = DispatchQueue(label: "ink.xelay.private-store")
    private let configuration: AppConfiguration
    private let directory: URL
    private let stateURL: URL
    private let lockURL: URL

    init(configuration: AppConfiguration) throws {
        self.configuration = configuration
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: configuration.appGroup) else { throw XelayError.configuration }
        directory = container.appendingPathComponent("PrivateWidgetCache", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            var protectedDirectory = directory
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try protectedDirectory.setResourceValues(values)
        } catch { throw XelayError.storage }
        stateURL = directory.appendingPathComponent("state-v1.json")
        lockURL = directory.appendingPathComponent("coordination.lock")
    }

    final class Access {
        var state: SharedState
        private let store: SharedStore
        init(state: SharedState, store: SharedStore) { self.state = state; self.store = store }
        func save() throws { try store.writeState(state) }
        func session() throws -> StoredSession? {
            guard let value = try store.readKeychain() else {
                // Never reinterpret inaccessible/corrupt keychain as a logout.
                if state.accountID != nil { throw XelayError.secureStorage }
                return nil
            }
            guard value.epoch == state.epoch, value.account.id == state.accountID else { return nil }
            return value
        }
        func writeSession(_ session: StoredSession) throws {
            try store.writeKeychain(session)
            // ISO persistence has millisecond precision. Compare the canonical
            // serialized record, not a sub-millisecond Date() fallback expiry.
            let canonical = try WireJSON.decoder().decode(StoredSession.self, from: WireJSON.encoder().encode(session))
            guard try store.readKeychain() == canonical else { throw XelayError.secureStorage }
        }
        func clearSession() throws {
            // Commit the empty epoch first: even a failed keychain deletion or a
            // killed process can never resurrect an old account's cached data.
            state = SharedState(); try save(); try store.deleteKeychain()
        }
        func require(_ session: StoredSession) throws {
            guard state.epoch == session.epoch, state.accountID == session.account.id,
                  try self.session()?.account.id == session.account.id else { throw XelayError.sessionChanged }
        }
        func require(_ ticket: RequestTicket) throws {
            try require(ticket.session)
            guard state.cacheEpoch == ticket.cacheEpoch,
                  ticket.groupsRequestID == nil || state.latestGroupsRequestID == ticket.groupsRequestID else { throw XelayError.sessionChanged }
        }
        func evict(groupID: UUID?) throws {
            state.cacheEpoch = UUID()
            if let groupID {
                state.snapshots.removeValue(forKey: groupID.uuidString.lowercased())
                state.groups.removeAll { $0.group.id == groupID }
            } else { state.snapshots = [:]; state.groups = []; state.groupsUpdatedAt = nil }
            try save()
        }
    }

    /// Call from a background queue. Do not nest this method, unlink the lock
    /// file, or publish a network result without rechecking its captured epoch.
    func locked<T>(_ operation: (Access) throws -> T) throws -> T {
        try coordinated {
            let state: SharedState
            if !FileManager.default.fileExists(atPath: stateURL.path) {
                state = SharedState(); try writeState(state)
            } else {
                do {
                    let size = try FileManager.default.attributesOfItem(atPath: stateURL.path)[.size] as? NSNumber
                    guard (size?.intValue ?? Int.max) <= 8 * 1024 * 1024 else { throw XelayError.storage }
                    state = try WireJSON.decoder().decode(SharedState.self, from: Data(contentsOf: stateURL))
                    guard state.groups.count <= 50, state.snapshots.count <= 50,
                          state.groups.allSatisfy({ $0.accountID == state.accountID }) else { throw XelayError.storage }
                    for (key, snapshot) in state.snapshots {
                        guard let id = UUID(uuidString: key), state.accountID != nil else { throw XelayError.storage }
                        try snapshot.validate(expectedGroup: id)
                    }
                } catch let error as XelayError { throw error }
                catch { throw XelayError.storage }
            }
            return try operation(Access(state: state, store: self))
        }
    }
    /// Explicit user-confirmed recovery only. This path can clear a corrupt
    /// state file or unreadable Keychain without first decoding either one.
    func resetLocalData() throws {
        try coordinated { try writeState(SharedState()); try deleteKeychain() }
    }
    private func coordinated<T>(_ operation: () throws -> T) throws -> T {
        try Self.queue.sync {
            let descriptor = open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
            guard descriptor >= 0 else { throw XelayError.storage }
            defer { close(descriptor) }
            let deadline = Date().addingTimeInterval(20)
            while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
                guard errno == EWOULDBLOCK || errno == EAGAIN else { throw XelayError.storage }
                guard Date() < deadline else { throw XelayError.storageBusy }
                Thread.sleep(forTimeInterval: 0.025)
            }
            defer { flock(descriptor, LOCK_UN) }
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: lockURL.path)
            return try operation()
        }
    }

    private func writeState(_ state: SharedState) throws {
        do {
            let data = try WireJSON.encoder().encode(state)
            guard data.count <= 8 * 1024 * 1024 else { throw XelayError.storage }
            try data.write(to: stateURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { throw XelayError.storage }
    }
    private var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "ink.xelay.widget-session.v1",
         kSecAttrAccount as String: "current-account",
         kSecAttrAccessGroup as String: configuration.keychainAccessGroup,
         kSecAttrSynchronizable as String: false]
    }
    private func readKeychain() throws -> StoredSession? {
        var query = keychainQuery
        query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        if status == errSecInteractionNotAllowed || status == errSecNotAvailable { throw XelayError.protectedData }
        guard status == errSecSuccess, let data = result as? Data, data.count <= 64 * 1024,
              let session = try? WireJSON.decoder().decode(StoredSession.self, from: data),
              !session.accessToken.isEmpty, !session.refreshToken.isEmpty else { throw XelayError.secureStorage }
        return session
    }
    private func writeKeychain(_ session: StoredSession) throws {
        let data = try WireJSON.encoder().encode(session)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(keychainQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = keychainQuery; attributes.forEach { item[$0.key] = $0.value }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw XelayError.secureStorage }
    }
    private func deleteKeychain() throws {
        let status = SecItemDelete(keychainQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw XelayError.secureStorage }
    }
}
