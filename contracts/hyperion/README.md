# Hyperion contracts

This directory is the canonical and only contract source tree for QNS. It targets the QRL 2.0 Hyperion compiler with 64-byte addresses, 64-byte VM words, and 64-byte ABI slots.

## Compile

```bash
HYPERION_COMPILER=../hyperion/build/hypc/hypc npm run compile:hyperion
```

Artifacts are written to `build/hyperion/` and remain untracked. `manifest.json` records each deployable source, contract name, ABI file, and bytecode file.

Deployable contracts are listed in `scripts/compile-hyperion.js`:

- `ENSRegistry`
- `Root`
- `ReverseRegistrar`
- `FIFSQRLRegistrar`
- `QRLPublicResolver`
- `QRLSignatureVerifier`

## QRL 2.0 rules

- Native addresses contain 64 bytes and use a `Q` prefix when represented as text.
- ABI words contain 64 bytes.
- `bytes32` values are left-aligned inside ABI words.
- Reverse address labels hash 128 lowercase hex characters.
- SHAKE256 produces a fixed 64-byte digest.
- ML-DSA-87 verification accepts a 64-byte digest, a 4627-byte signature, a 2592-byte public key, and up to 255 context bytes.

The Solidity mirror and Foundry test path were removed during the QRL 2.0 migration, including 28 forward and reverse lifecycle tests. The current Hyperion compilation, formal policy, SDK, and local-network checks cover the new QRL 2.0 boundaries. A Hyperion-native behavioral harness still needs to restore re-registration, operator-approval, subnode-churn, and related lifecycle coverage before production.
