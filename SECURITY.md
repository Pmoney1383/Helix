# Security

Helix runs agents with your logins on your own PC and can approve destructive actions, so security reports matter.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting instead: on this repository,
open **Security > Report a vulnerability**. Include the steps to reproduce, what an attacker gains, and the affected
version or commit. You will get a reply as soon as possible, and credit in the fix if you want it.

## What is in scope

- The gateway's authentication: pairing, device tokens, request signing, OAuth for hosted connectors.
- The approval gate and the destructive-action classifier (`pc-gateway/src/permissions/`), including bypasses
  that make a destructive action run without approval.
- Hosted access (`pc.hosted` scope, `hosted-safety.ts`): reading credentials, writing, or running unsafe commands.
- Anything reachable through Tailscale Funnel other than `/mcp`, `/oauth/*` and `/.well-known/*`.
- Desktop control escaping its grant or its approvals.

## Known limits (not vulnerabilities)

- The classifier matches patterns. Indirect deletion, where an agent writes a script that deletes files and then runs
  it, is a documented gap. It is a strong guardrail, not a sandbox.
- Overwriting a file with a write tool is not gated.
- Anyone with access to your tailnet and a paired device token can act as that device. Revoke lost phones with
  `DELETE /v1/devices/:id`, and consider `HELIX_REQUIRE_DEVICE_SIGNING=true`.
- Request signing does not stop code running on the unlocked phone, the software key used where there is no Secure
  Enclave is only as safe as the Keychain, and the nonce cache is lost on a gateway restart. See
  [docs/DEVICE-SIGNING.md](docs/DEVICE-SIGNING.md).
