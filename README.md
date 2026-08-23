# QNS: QRL Name Service

QNS is a Hyperion-native naming service for QRL 2.0. It keeps the stable ENS v1 registry model, uses native 64-byte QRL addresses, and adds post-quantum signing groundwork with SHAKE256 and ML-DSA-87.

Status: active QRL 2.0 migration work. The contracts compile only with the 64-byte Hyperion toolchain. A local `config/testnet.json` may retain the legacy 20-byte Testnet V2 deployment as historical state; that file is ignored because deployment records can contain private infrastructure details. Use a fresh 64-byte network for new deployments.

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

The local node image is built from the sibling `go-qrl/` precompile branch. Qrysm is pinned to `cyyber/qrysm@b53fd7c4`, and the genesis generator is pinned to `theQRL/qrl-genesis-generator@6a11fbce`. Image revision labels and running container image IDs are checked before reuse. Stale or missing images are rebuilt; `QNS_FORCE_REBUILD=1` forces a clean image refresh for a new enclave. The standalone builder labels dirty go-qrl inputs, and the start script refuses a dirty checkout because its commit alone cannot identify the image source.

The qrl-package execution client listens on `0.0.0.0` inside its container and enables admin, Engine, debug, and txpool APIs. `port_publisher.nat_exit_ip` controls P2P advertisement only. Docker normally publishes unspecified host addresses on every interface, so `npm run kurtosis:start` probes Docker's actual bind behavior and refuses startup unless every published address is loopback. Configure Docker's default bind for user-defined bridge networks to `127.0.0.1`, or use `QNS_ALLOW_WILDCARD_BIND=1` only after applying and verifying host-level access controls. The client URL `http://127.0.0.1:32002` and the deployer loader's loopback URL guard do not attest the host bind scope. Review Docker's public [port-binding](https://docs.docker.com/engine/network/port-publishing/) and [firewall](https://docs.docker.com/engine/network/packet-filtering-firewalls/) guidance before using this composition on a shared or public-IP host.

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

This command-scoped selector is accepted only when the configured RPC URL has a loopback host and the connected chain ID is `3151908`. That URL check is one fixture-selection guard; the startup bind check separately protects host exposure. When explicitly set, the selector takes precedence over a `TESTNET_SEED` in the ignored `.env`. Keep `QNS_PUBLIC_DEV_ACCOUNT` out of persistent `.env` files. Use `TESTNET_SEED` for other development networks. Never put a private seed in tracked files or shell history.

The initial deployment account remains the owner of `Root`, a Root controller, and the owner of `ReverseRegistrar`. Treat that account as an alpha administrator until the community selects a governance owner and an explicit controller-revocation plus ownership-transfer procedure. Do not renounce these roles before verifying the complete handoff on the target network.

Validated locally on 2026-08-23: the execution, beacon, and validator services produced blocks; six Hyperion contracts deployed; `alice.qrl` passed forward resolution, reverse resolution, and forward confirmation; raw precompile calls and the deployed wrapper passed SHAKE256 plus valid and invalid ML-DSA-87 checks. The enclave was subsequently stopped to release host resources.

## License

GPL-3.0. The Hyperion files under `contracts/hyperion/vendored/` retain the upstream ENS and OpenZeppelin notices applicable to their source.
