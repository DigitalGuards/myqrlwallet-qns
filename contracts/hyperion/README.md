# Hyperion contracts

This directory is the canonical and only contract source tree for QNS. It targets the QRL 2.0 Hyperion compiler with 64-byte addresses, 64-byte VM words, and 64-byte ABI slots.

## Compile

```bash
npm run compile:hyperion
```

The command defaults to the central 64-byte compiler at `../hyperion/build/hypc/hypc` and fails unless its exact version and SHA-256 match `config/hyperion-toolchain.json`. `HYPERION_COMPILER` and `HYPC_BIN` may select an identical reviewed binary at another path. Artifacts are written to `build/hyperion/` and remain untracked. Deployable artifact compilation explicitly uses via-IR. `manifest.json` records and verifies that codegen mode alongside the `qrl2-pq-v1` target, compiler path, compiler version and binary hash, complete Hyperion source-tree hash, and per-contract source, ABI, and bytecode hashes.

Deployable contracts are listed in `scripts/compile-hyperion.js`:

- `QNSRegistry` (vendored registry, ported from ENS v1)
- `Root`
- `ReverseRegistrar`
- `FIFSQRLRegistrar`
- `QRLPublicResolver`
- `QRLSignatureVerifier`

## QRL 2.0 rules

- Native addresses contain 64 bytes and use a `Q` prefix when represented as text.
- ABI words contain 64 bytes.
- `bytes32` values are left-aligned inside ABI words.
- Mapping accessors for native addresses and `bytes32` keys use explicit typed functions over private storage. This preserves the complete key under legacy and via-IR codegen while retaining the established ABI selectors.
- Reverse address labels hash 128 lowercase hex characters.
- SHAKE256 produces a fixed 64-byte digest.
- ML-DSA-87 verification accepts a 64-byte digest, a 4627-byte signature, a 2592-byte public key, and up to 255 context bytes. Hyperion packs the raw slot 3 frame in public-key-then-signature order with a one-byte context length, and maps both candidate failure return forms to `false`.

The Solidity mirror and Foundry test path were removed during the QRL 2.0 migration, including 28 forward and reverse lifecycle tests. The current Hyperion compilation, formal policy, SDK, and local-network checks cover the new QRL 2.0 boundaries. The native semantic gate checks alias-shaped Q128 and `bytes32` mapping keys with default and optimized legacy and via-IR pipelines. A Hyperion-native behavioral harness still needs to restore re-registration, operator-approval, subnode-churn, and related lifecycle coverage before production.
