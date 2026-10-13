import CryptoKit
import Foundation
import Testing
@testable import Helix

@MainActor
struct DeviceSignerTests {
    @Test func signingStringHasSevenLinesInOrder() {
        let text = DeviceSigner.signingString(method: "post", target: "/v1/sessions?x=1", timestamp: "1791612728679",
                                              nonce: "abcdefghijklmnop", bodySHA256: "hash", deviceID: "dev1")
        #expect(text == "HELIX-SIGN-V1\nPOST\n/v1/sessions?x=1\n1791612728679\nabcdefghijklmnop\nhash\ndev1")
    }

    @Test func emptyBodyHashMatchesTheGatewayConstant() {
        #expect(DeviceSigner.sha256Hex(Data()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    @Test func signedRequestVerifiesAgainstThePublicKey() throws {
        DeviceSigner.ensureKey(replacing: true)
        defer { DeviceSigner.forget() }
        var request = URLRequest(url: URL(string: "https://host.example/v1/sessions?x=1")!)
        request.httpMethod = "POST"
        request.httpBody = Data("{\"a\":1}".utf8)
        request.setValue("Bearer t", forHTTPHeaderField: "Authorization")
        let signed = DeviceSigner.sign(request, deviceID: "dev1", now: Date(timeIntervalSince1970: 1_791_612_728.679), nonce: "abcdefghijklmnop")

        #expect(signed.value(forHTTPHeaderField: "X-Helix-Timestamp") == "1791612728679")
        #expect(signed.value(forHTTPHeaderField: "X-Helix-Body-SHA256") == DeviceSigner.sha256Hex(Data("{\"a\":1}".utf8)))
        let text = DeviceSigner.signingString(method: "POST", target: "/v1/sessions?x=1", timestamp: "1791612728679",
                                              nonce: "abcdefghijklmnop", bodySHA256: DeviceSigner.sha256Hex(Data("{\"a\":1}".utf8)), deviceID: "dev1")
        let key = try P256.Signing.PublicKey(derRepresentation: Data(base64Encoded: DeviceSigner.publicKeyBase64!)!)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: Data(base64Encoded: signed.value(forHTTPHeaderField: "X-Helix-Signature")!)!)
        #expect(key.isValidSignature(signature, for: Data(text.utf8)))
    }

    @Test func enrollmentProofVerifies() throws {
        DeviceSigner.ensureKey(replacing: true)
        defer { DeviceSigner.forget() }
        let pub = DeviceSigner.publicKeyBase64!
        let key = try P256.Signing.PublicKey(derRepresentation: Data(base64Encoded: pub)!)
        let proof = try P256.Signing.ECDSASignature(rawRepresentation: Data(base64Encoded: DeviceSigner.enrollmentProof()!)!)
        #expect(key.isValidSignature(proof, for: Data(("helix-enroll-v1\n" + pub).utf8)))
    }

    @Test func requestsWithoutABearerTokenAreNotSigned() {
        DeviceSigner.ensureKey(replacing: true)
        defer { DeviceSigner.forget() }
        let request = URLRequest(url: URL(string: "https://host.example/v1/pair/complete")!)
        #expect(DeviceSigner.sign(request, deviceID: "dev1").value(forHTTPHeaderField: "X-Helix-Signature") == nil)
    }

    @Test func nonceIsValidAndFresh() {
        let a = DeviceSigner.makeNonce(), b = DeviceSigner.makeNonce()
        #expect(a != b)
        #expect(a.range(of: "^[A-Za-z0-9_-]{16,64}$", options: .regularExpression) != nil)
    }
}
