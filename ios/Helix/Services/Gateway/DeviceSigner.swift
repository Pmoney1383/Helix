import CryptoKit
import Foundation
import Security

/// Device-key request signing (docs/DEVICE-SIGNING.md, gateway `device-signing.ts`). The private key
/// lives in the Secure Enclave and never leaves the phone; the gateway keeps the public half and,
/// once it has one, refuses any request from this device that is not signed with it. A stolen
/// bearer token alone is then useless. The simulator has no Secure Enclave, so it uses a software
/// key of the same type.
enum DeviceSigner {
    private enum Key {
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)

        var publicKey: P256.Signing.PublicKey {
            switch self {
            case let .enclave(key): key.publicKey
            case let .software(key): key.publicKey
            }
        }

        func sign(_ data: Data) throws -> P256.Signing.ECDSASignature {
            switch self {
            case let .enclave(key): try key.signature(for: data)
            case let .software(key): try key.signature(for: data)
            }
        }

        /// Stored in the Keychain as text: "se:" + the Secure Enclave handle, or "sw:" + raw key.
        var stored: String {
            switch self {
            case let .enclave(key): "se:" + key.dataRepresentation.base64EncodedString()
            case let .software(key): "sw:" + key.rawRepresentation.base64EncodedString()
            }
        }

        init?(stored: String) {
            if stored.hasPrefix("se:"), let data = Data(base64Encoded: String(stored.dropFirst(3))),
               let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data) {
                self = .enclave(key)
            } else if stored.hasPrefix("sw:"), let data = Data(base64Encoded: String(stored.dropFirst(3))),
                      let key = try? P256.Signing.PrivateKey(rawRepresentation: data) {
                self = .software(key)
            } else {
                return nil
            }
        }
    }

    private static var cached: Key?

    private static var key: Key? {
        if let cached { return cached }
        guard let stored = KeychainStore.get(.signingKey), let key = Key(stored: stored) else { return nil }
        cached = key
        return key
    }

    static var hasKey: Bool { key != nil }

    /// SPKI DER, base64 - what the gateway stores.
    static var publicKeyBase64: String? { key?.publicKey.derRepresentation.base64EncodedString() }

    /// Creates a key if there is none yet. `replacing` makes a fresh one (a new pairing).
    @discardableResult
    static func ensureKey(replacing: Bool = false) -> Bool {
        if replacing { forget() }
        if key != nil { return true }
        let created: Key
        if SecureEnclave.isAvailable,
           let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, nil),
           let enclave = try? SecureEnclave.P256.Signing.PrivateKey(accessControl: access) {
            created = .enclave(enclave)
        } else {
            created = .software(P256.Signing.PrivateKey())
        }
        KeychainStore.set(created.stored, for: .signingKey)
        cached = created
        return true
    }

    /// Puts back a key saved before a pairing attempt that failed.
    static func restore(_ stored: String?) {
        forget()
        if let stored { KeychainStore.set(stored, for: .signingKey) }
    }

    static func forget() {
        cached = nil
        KeychainStore.delete(.signingKey)
    }

    /// Proof of holding the key: a signature of `"helix-enroll-v1\n" + publicKey`.
    static func enrollmentProof() -> String? {
        guard let key, let pub = publicKeyBase64 else { return nil }
        return (try? key.sign(Data(("helix-enroll-v1\n" + pub).utf8)))?.rawRepresentation.base64EncodedString()
    }

    /// The seven-line text that gets signed. Public so tests can pin the exact format.
    static func signingString(method: String, target: String, timestamp: String, nonce: String, bodySHA256: String, deviceID: String) -> String {
        ["HELIX-SIGN-V1", method.uppercased(), target, timestamp, nonce, bodySHA256, deviceID].joined(separator: "\n")
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Adds the four `X-Helix-*` headers. Only requests that carry the bearer token are signed
    /// (pairing and health are not), and only once this device has a key. Call it with the final
    /// body already set: the hash covers exactly those bytes.
    static func sign(_ request: URLRequest, deviceID: String?, now: Date = .now, nonce: String = makeNonce()) -> URLRequest {
        guard request.value(forHTTPHeaderField: "Authorization") != nil,
              let key, let deviceID, let url = request.url,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return request }
        var target = components.percentEncodedPath
        if let query = components.percentEncodedQuery { target += "?" + query }
        let timestamp = String(Int64(now.timeIntervalSince1970 * 1000))
        let bodyHash = sha256Hex(request.httpBody ?? Data())
        let text = signingString(method: request.httpMethod ?? "GET", target: target, timestamp: timestamp, nonce: nonce, bodySHA256: bodyHash, deviceID: deviceID)
        guard let signature = try? key.sign(Data(text.utf8)) else { return request }
        var signed = request
        signed.setValue(timestamp, forHTTPHeaderField: "X-Helix-Timestamp")
        signed.setValue(nonce, forHTTPHeaderField: "X-Helix-Nonce")
        signed.setValue(bodyHash, forHTTPHeaderField: "X-Helix-Body-SHA256")
        signed.setValue(signature.rawRepresentation.base64EncodedString(), forHTTPHeaderField: "X-Helix-Signature")
        return signed
    }

    /// 12 random bytes as base64url: 16 characters, new for every request.
    static func makeNonce() -> String {
        Data((0..<12).map { _ in UInt8.random(in: .min ... .max) }).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
