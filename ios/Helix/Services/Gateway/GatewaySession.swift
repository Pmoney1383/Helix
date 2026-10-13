import Foundation
import Observation

/// The app's connection to one PC gateway: where it is, and the bearer token pairing returned.
/// Persisted across launches - the address in UserDefaults (not sensitive), the token in the
/// Keychain (see `KeychainStore`). Loaded once at init; everything else in the app reads this
/// rather than touching UserDefaults/Keychain directly.
@Observable
final class GatewaySession {
    private enum DefaultsKey {
        static let baseURLString = "gateway.baseURLString"
    }

    /// The gateway's Tailscale Serve address, pre-filled in the pairing sheet and editable there.
    /// Comes from HELIX_GATEWAY_HOST in ios/Config/Helix.local.xcconfig; a placeholder when unset.
    static let defaultBaseURLString: String = {
        let host = (Bundle.main.object(forInfoDictionaryKey: "HelixGatewayHost") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return host.isEmpty ? "https://your-pc.your-tailnet.ts.net" : "https://\(host)"
    }()

    private(set) var baseURL: URL
    private(set) var deviceToken: String?
    private(set) var deviceID: String?

    var isPaired: Bool { deviceToken != nil }

    init() {
        let stored = UserDefaults.standard.string(forKey: DefaultsKey.baseURLString) ?? Self.defaultBaseURLString
        baseURL = URL(string: stored) ?? URL(string: Self.defaultBaseURLString)!
        deviceToken = KeychainStore.get(.deviceToken)
        deviceID = KeychainStore.get(.deviceID)
    }

    /// An in-memory connection, also useful for deterministic networking tests.
    init(baseURL: URL, deviceToken: String?, deviceID: String? = nil) {
        self.baseURL = baseURL
        self.deviceToken = deviceToken
        self.deviceID = deviceID
    }

    func setBaseURL(_ url: URL) {
        baseURL = url
        UserDefaults.standard.set(url.absoluteString, forKey: DefaultsKey.baseURLString)
    }

    /// Called once pairing succeeds.
    func store(deviceID: String, token: String) {
        self.deviceID = deviceID
        self.deviceToken = token
        KeychainStore.set(deviceID, for: .deviceID)
        KeychainStore.set(token, for: .deviceToken)
    }

    /// Forget this device's pairing (keeps the gateway address). "Pair Again" overwrites the
    /// token directly without needing this, so this is here for a future explicit sign-out.
    func forget() {
        deviceToken = nil
        deviceID = nil
        KeychainStore.deleteAll()
        DeviceSigner.forget()
    }
}
