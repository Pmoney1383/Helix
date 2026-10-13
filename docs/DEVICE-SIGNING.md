# Device-key request signing

Pairing gives the phone a bearer token. On its own, anyone who copies that token can act as the phone. Request
signing adds a second factor: a private key that stays on the phone. Once the gateway knows the matching public key,
every request from that device must carry a valid signature, so a stolen token alone is no longer enough.

Gateway: `pc-gateway/src/api/device-signing.ts` and `pc-gateway/src/api/auth.ts`. App:
`ios/Helix/Services/Gateway/DeviceSigner.swift`.

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
  `GET /v1/devices/me/key`. If no key is enrolled, it sends `PUT /v1/devices/me/key` (bearer token only, since there is
  nothing to check a signature against yet). This happens before the WebSocket connects. An update to the app is
  enough; you do not need to pair again.
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

## `HELIX_REQUIRE_DEVICE_SIGNING`

A device that has a key enrolled must **always** sign, whatever this setting says. The setting only decides what
happens to devices without a key:

| | `false` (default) | `true` |
|---|---|---|
| Paired device with no key | Allowed, unsigned | Refused (`401 key_required`), except the two `/v1/devices/me/key` calls it needs to enroll |
| Pairing without a public key | Allowed | Refused (`400 key_required`) |

Turn it on only after every phone you use shows signing as **On**. Clients that do not sign, such as the
`npm run client` test CLI, cannot pair or connect while it is on. Hosted connectors (ChatGPT, claude.ai) use OAuth
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
- The nonce cache is in memory, so it is empty after the gateway restarts. A captured request could then be replayed
  until its timestamp is more than 120 seconds old.
- Signing is off by default. The phone has to run an app version with signing, and you have to turn on
  `HELIX_REQUIRE_DEVICE_SIGNING`, before devices without a key are shut out.
