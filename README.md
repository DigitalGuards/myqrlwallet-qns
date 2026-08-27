# QNS: QRL Name Service

QNS is a Hyperion-native naming service for QRL 2.0. It keeps the stable ENS v1 registry model, uses native 64-byte QRL addresses, and adds post-quantum signing groundwork with SHAKE256 and ML-DSA-87.

Status: active QRL 2.0 migration work. The contracts compile only with the 64-byte Hyperion toolchain. A local `config/testnet.json` may retain the legacy 20-byte Testnet V2 (chain ID 1337) deployment as historical state; that file is ignored because deployment records can contain private infrastructure details. Use a fresh 64-byte network for new deployments.

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
config/               Network configuration; deployment records stay local and ignored
docs/                 Protocol decisions, migration notes, and QIP groundwork
```

## Build and test

```bash
npm install
npm --prefix sdk install
HYPERION_COMPILER=../hyperion/build/hypc/hypc npm test
```

The test command compiles every deployable contract with Hyperion, runs the deployment-script unit tests, type-checks the SDK, and runs its unit tests. `npm run test:behavior` runs the live contract behavior suite against a deployed stack (it skips itself when `QNS_BEHAVIOR=1` is not set).

Build Hyperion with Z3 support and run the reproducible formal security gate with:

```bash
HYPERION_FORMAL_COMPILER=../hyperion/build-formal/hypc/hypc npm run verify:formal
```

The gate currently proves 36 CHC targets covering the cryptographic boundary, exact QNS context bytes, resolver capabilities, unauthorized transitions, and 64-byte reverse-index arithmetic. See [`docs/FORMAL-SECURITY-VERIFICATION.md`](docs/FORMAL-SECURITY-VERIFICATION.md) for the threat model, exact claims, evidence classes, and assumptions.

## Documentation

- [`docs/draft-qrl2-pq-precompiles.md`](docs/draft-qrl2-pq-precompiles.md): the draft QIP for the SHAKE256 and ML-DSA-87 verification precompiles.
- [`docs/CRYPTO-INTEGRATION.md`](docs/CRYPTO-INTEGRATION.md): the signing profile and precompile framing.
- [`docs/ADDRESS-COMPATIBILITY.md`](docs/ADDRESS-COMPATIBILITY.md): 64-byte address representation.
- [`docs/FORMAL-SECURITY-VERIFICATION.md`](docs/FORMAL-SECURITY-VERIFICATION.md): the machine-checked proof gate.
- [`docs/PORT-PLAN.md`](docs/PORT-PLAN.md), [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md): migration plan, direction, and open decisions.

## Local QRL 2.0 network

Prerequisites: Docker, Kurtosis, ripgrep (`rg`), and `socat`. The sibling `qrl-package/` checkout contains Cyyber's Kurtosis package with 64-byte genesis accounts. The published Qrysm `latest` images inspected on 2026-08-23 predated the 64-byte changes, so this repository builds pinned beacon, validator, and genesis-generator images from source.

```bash
npm run build:local-network
npm run kurtosis:start
kurtosis enclave inspect qrl2-qns-pq
```

The local node image is built from the sibling `go-qrl/` precompile branch. Qrysm is pinned to `cyyber/qrysm@b53fd7c4`, and the genesis generator is pinned to `theQRL/qrl-genesis-generator@6a11fbce`. A tracked patch adds `qrl2PQPrecompilesTime: 0` to generated development genesis files. Images record the upstream revision plus the patch or complete go-qrl content hash. Startup recomputes those hashes and verifies each running service image ID, so a precisely identified dirty review tree can be exercised without treating its Git commit as sufficient provenance. `QNS_FORCE_REBUILD=1` forces an image refresh for a new enclave.

The qrl-package execution client listens on `0.0.0.0` inside its container and enables admin, Engine, debug, and txpool APIs. Setting `port_publisher.*.enabled` to `false` disables the package's fixed public port ranges. Kurtosis 1.20.0 still maps declared service ports to ephemeral host ports; on the validated engine every mapping used `127.0.0.1`. Startup inspects `NetworkSettings.Ports` for every running enclave service and fails closed if any mapping is not loopback. It then starts a project-owned `socat` proxy for the stable HTTP RPC URL `127.0.0.1:32002`, managed by the user systemd instance when available and by a checked PID fallback otherwise. `port_publisher.nat_exit_ip` controls P2P advertisement only. Run `npm run kurtosis:stop` to stop the proxy and enclave together.

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

The local config must declare `"qrl2PrecompileSet": "qrl2-pq-v1"`. Deployment verifies the exact compiler, source, ABI, and bytecode hashes, checks the chain ID, and executes live 64-byte ML-DSA-87 slot 3 plus SHAKE256 slot 6 probes before its first transaction. The command-scoped public account selector is accepted only when the configured RPC URL has a loopback host and the connected chain ID is `3151908`. When explicitly set, the selector takes precedence over a `TESTNET_SEED` in the ignored `.env`. Keep `QNS_PUBLIC_DEV_ACCOUNT` out of persistent `.env` files. Use `TESTNET_SEED` for other development networks. Never put a private seed in tracked files or shell history.

The initial deployment account remains the owner of `Root`, a Root controller, and the owner of `ReverseRegistrar`. Treat that account as an alpha administrator until the community selects a governance owner and an explicit controller-revocation plus ownership-transfer procedure. Do not renounce these roles before verifying the complete handoff on the target network.

Validated locally on 2026-08-26: the execution, beacon, and validator services produced blocks with chain ID `3151908` and genesis activation `qrl2PQPrecompilesTime: 0`. Six current Hyperion contracts deployed. A fresh `.qrl` name passed forward resolution, reverse resolution, and forward confirmation through the SDK. All nine direct and wrapped PQ checks passed, including the SHAKE256 vector, valid and invalid ML-DSA-87 calls, mutated digest and public-key rejection, context lengths 0 and 255, cross-context rejection, and the exact 64-byte digest boundary. The live Hyperion behavior suite passed its eight lifecycle and authorization subtests. Every observed Kurtosis host mapping was loopback-only, and block height advanced during the final health probe. The validated enclave and RPC proxy were subsequently stopped to release host resources.

## License

GPL-3.0. The Hyperion files under `contracts/hyperion/vendored/` retain the upstream ENS and OpenZeppelin notices applicable to their source.
