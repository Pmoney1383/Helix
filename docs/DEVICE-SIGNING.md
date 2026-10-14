# Device-key request signing

Pairing gives the phone a bearer token. On its own, anyone who copies that token can act as the phone. Request
signing adds a second factor: a private key that stays on the phone. Once the gateway knows the matching public key,
every request from that device must carry a valid signature, so a stolen token alone is no longer enough.

Gateway: `pc-gateway/src/api/device-signing.ts` and `pc-gateway/src/api/auth.ts`. Apps:
`ios/Helix/Services/Gateway/DeviceSigner.swift` and `android/app/src/main/java/app/helix/gateway/DeviceSigner.kt`.

**On Android** the key is an ECDSA P-256 key in the Android Keystore, in StrongBox (a separate secure chip) when the
phone has one and in the TEE otherwise; it cannot be exported. Signatures are DER-encoded, which the gateway accepts
as well as the iPhone's raw form. Enrollment, the signed headers, the Settings row and recovery are the same as below.

## The key on the phone

- The app creates an ECDSA P-256 key in the **Secure Enclave** (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
  The private key cannot be exported and does not move to another phone through a backup or restore.
- If the Secure Enclave is not available (the iOS Simulator), or creating the key there fails, the app falls back to a
  **software** P-256 key. That key is stored in the app's Keychain (same access class), so it is weaker than a Secure
  Enclave key: its private half is readable by anything that can read the app's Keychain items.
- The Keychain entry is deleted when the app forgets its pairing.

## Enrollment

- **New pairing.** The app makes a fresh key and sends its public key, plus a proof (a signature of
  `helix-enroll-v1\n<public key>`), with the pairing code. The gateway checks the proof before it uses up the code.
  If pairing fails (for example a wrong code), the app puts its previous key back so an existing pairing keeps working.
- **A phone that paired before signing existed.** At launch and after pairing, once `/health` answers, the app asks
  `GET /v1/devices/me/key`. If no key is enrolled, it must prove the owner is at the PC before a key is accepted: a
  bearer token alone could have been copied, and whoever enrolls first owns the device from then on. Send
  `PUT /v1/devices/me/key {publicKey, keyProof, pairingCode}` with a fresh one-time code from `npm run pair`.
  Without a code the gateway answers `403 pairing_required`; an expired, used or wrong code gets
  `401 invalid_pairing_code`; a bad key or proof gets `400` and does not use up the code. The simplest path is to
  pair again (**Settings > Pair Again…**), which enrolls the key as part of pairing.
- **Once only.** A device's key can be enrolled one time. A second enrollment gets `409 already_enrolled`, so a stolen
  token cannot swap in an attacker's key. To change the key, pair again.

## What gets signed

Every request that carries the bearer token, including the WebSocket upgrade (`GET /v1/ws`). `/health` and
`/v1/pair/complete` are not signed. Each signed request has four headers:

| Header | Content |
|---|---|
| `X-Helix-Timestamp` | Unix time in milliseconds |
| `X-Helix-Nonce` | New for every request. The app sends 12 random bytes as base64url (16 characters); the gateway accepts 16 to 64 characters of `A-Z a-z 0-9 _ -` |
| `X-Helix-Body-SHA256` | Hex SHA-256 of the exact body bytes (of the empty string when there is no body) |
| `X-Helix-Signature` | Base64 ECDSA signature of the signing string |

The signing string is seven lines joined by `\n`: `HELIX-SIGN-V1`, the method in upper case, the path and query as
sent, the timestamp, the nonce, the body hash and the device ID.

The gateway refuses a request (`401` with the reason) when the headers are missing, the timestamp is more than
120 seconds off the gateway's clock, the nonce is malformed or was already used by that device, the body hash does
not match the received bytes, or the signature does not verify. Rejections are written to the audit log.

Used nonces are stored in the gateway's database for five minutes, so a restart does not make old requests
replayable. If that store is ever full, new signed requests get `429 nonce_capacity` with `Retry-After: 60`
instead of the gateway forgetting nonces that are still valid. Back off, then sign a fresh request.

Revoking a device (`DELETE /v1/devices/:id`) or enrolling its key closes that device's open WebSockets at once
(close code `1008`), and every socket rechecks its device before each command and event. On `1008`, check the
pairing and signing status before reconnecting.

## `HELIX_REQUIRE_DEVICE_SIGNING`

A device that has a key enrolled must **always** sign, whatever this setting says. The setting only decides what
happens to devices without a key:

| | `false` | `true` (default) |
|---|---|---|
| Paired device with no key | Allowed, unsigned | Refused (`401 key_required`), except the two `/v1/devices/me/key` calls it needs to enroll (enrolling also needs a fresh `pairingCode`) |
| Pairing without a public key | Allowed | Refused (`400 key_required`) |

It is on by default: the iPhone and Android apps enroll a key when they pair. A phone paired with an older app version
that has no key is refused until it enrolls; the app asks you to pair again, so run `npm run pair` on the PC and use
**Settings > Pair Again…**. Clients that do not sign, such as the `npm run client` test CLI, cannot pair or connect
while it is on; set `HELIX_REQUIRE_DEVICE_SIGNING=false` to use them. Hosted connectors (ChatGPT, claude.ai) use OAuth
and are not affected.

## Where to see it

In the app, **Settings > Gateway > Request signing** shows `On`, `Off` or `Checking…`. When something is wrong, a note
under it says so and asks you to pair again.

## Recovery

If the phone loses its key (a new or restored phone, a reinstall that cleared the Keychain), the gateway refuses its
requests, and the app shows "Pair again". Run `npm run pair` on the PC and use **Settings > Pair Again…**. Pairing
creates a new device record with the new key. The old record stays until you revoke it with
`DELETE /v1/devices/:id` (list devices with `GET /v1/devices`).

## Limits

- Signing protects against a copied token. It does not protect against code running on the unlocked phone itself,
  which can ask the Secure Enclave to sign.
- The software fallback key is only as safe as the Keychain.
- Turning `HELIX_REQUIRE_DEVICE_SIGNING` off lets devices without a key in again, so a copied token from such a
  device works on its own.
