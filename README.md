# QNS: QRL Name Service

QNS is a Hyperion-native naming service for QRL 2.0. It keeps the stable ENS v1 registry model, uses native 64-byte QRL addresses, and adds post-quantum signing groundwork with SHAKE256 and ML-DSA-87.

Status: active QRL 2.0 migration work. The contracts compile only with the 64-byte Hyperion toolchain. The deployment recorded in `config/testnet.json` belongs to the legacy 20-byte Testnet V2 network and is retained as historical state. Use a fresh 64-byte network for new deployments.

## Design

- Hyperion is the sole contract source language.
- `address` is the native 64-byte QRL type and occupies one 64-byte ABI word.
- `addr(bytes32)` is the canonical forward record.
- Reverse labels hash the 128 lowercase hex characters of a 64-byte address.
- Namehash remains Keccak-256 based for ENS compatibility.
- `QRLSignatureVerifier` exposes SHAKE256-512 digests and ML-DSA-87 verification with the `QNS-SIGN-v1` context.
- There is no ECDSA or `ecrecover` path.

## Structure

```text
contracts/hyperion/   Canonical registry, resolver, registrar, and crypto contracts
sdk/                  TypeScript namehash, resolution, and precompile helpers
scripts/              Hyperion compilation, deployment, and integration checks
config/               Network configuration and deployment records
docs/                 Protocol decisions, migration notes, and QIP groundwork
```

## Build and test

```bash
npm install
npm --prefix sdk install
HYPERION_COMPILER=../hyperion/build/hypc/hypc npm test
```

The test command compiles every deployable contract with Hyperion, type-checks the SDK, and runs its unit tests.

Build Hyperion with Z3 support and run the reproducible formal security gate with:

```bash
HYPERION_FORMAL_COMPILER=../hyperion/build-formal/hypc/hypc npm run verify:formal
```

The gate currently proves 36 CHC targets covering the cryptographic boundary, exact QNS context bytes, resolver capabilities, unauthorized transitions, and 64-byte reverse-index arithmetic. See [`docs/FORMAL-SECURITY-VERIFICATION.md`](docs/FORMAL-SECURITY-VERIFICATION.md) for the threat model, exact claims, evidence classes, and assumptions.

## Local QRL 2.0 network

The sibling `qrl-package/` checkout contains Cyyber's Kurtosis package with 64-byte genesis accounts. The published Qrysm `latest` images inspected on 2026-08-23 predated the 64-byte changes, so this repository builds pinned beacon, validator, and genesis-generator images from source.

```bash
npm run build:local-network
npm run kurtosis:start
kurtosis enclave inspect qrl2-qns
```

The local node image is built from the sibling `go-qrl/` precompile branch. Qrysm is pinned to `cyyber/qrysm@b53fd7c4`, and the genesis generator is pinned to `theQRL/qrl-genesis-generator@6a11fbce`. The start script builds any missing local image automatically.

Copy the reported execution RPC URL into `config/local-qip55.json`, compile, and deploy with:

```bash
HYPERION_COMPILER=../hyperion/build/hypc/hypc npm run compile
QNS_CONFIG=config/local-qip55.json npm run deploy:testnet
```

Select one of the public development accounts supplied by the Kurtosis package without copying its seed into your shell:

```bash
QNS_PUBLIC_DEV_ACCOUNT=0 npm run deploy:testnet
QNS_PUBLIC_DEV_ACCOUNT=0 npm run register -- alice
npm run verify:pq
```

This selector is accepted only for a loopback RPC on local Kurtosis chain `3151908`. When explicitly set, it takes precedence over a `TESTNET_SEED` in the ignored `.env`. Use `TESTNET_SEED` for other development networks. Never put a private seed in tracked files or shell history.

Validated locally on 2026-08-23: the execution, beacon, and validator services produced blocks; six Hyperion contracts deployed; `alice.qrl` passed forward resolution, reverse resolution, and forward confirmation; raw precompile calls and the deployed wrapper passed SHAKE256 plus valid and invalid ML-DSA-87 checks.

## License

GPL-3.0. The Hyperion files under `contracts/hyperion/vendored/` retain the upstream ENS and OpenZeppelin notices applicable to their source.
