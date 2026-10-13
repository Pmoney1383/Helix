import Foundation
import Security

/// Minimal Keychain wrapper, just enough for the one secret this app has: the device bearer
/// token from pairing. Not Codable-generic on purpose - a bigger wrapper is not worth it for
/// one string.
enum KeychainStore {
    /// kSecAttrService: scopes entries to this app. kSecAttrAccount is the "key" within that.
    private static let service = (Bundle.main.bundleIdentifier ?? "helix") + ".gateway"

    enum Key: String {
        case deviceToken
        case deviceID
        case signingKey
    }

    static func set(_ value: String, for key: Key) {
        let data = Data(value.utf8)
        var query = baseQuery(key)
        query[kSecValueData as String] = data
        // iPhone only, no iCloud Keychain sync, backups: a token on a new/restored device
        // should not silently resurrect - pairing should happen again on that device.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        // Try update first (the common case after the first pair); add if nothing to update.
        let attributesToUpdate: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(baseQuery(key) as CFDictionary, attributesToUpdate as CFDictionary)
        if updateStatus == errSecItemNotFound {
            SecItemAdd(query as CFDictionary, nil)
        }
    }

    static func get(_ key: Key) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(_ key: Key) {
        SecItemDelete(baseQuery(key) as CFDictionary)
    }

    static func deleteAll() {
        delete(.deviceToken)
        delete(.deviceID)
        delete(.signingKey)
    }

    private static func baseQuery(_ key: Key) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
        ]
    }
}
