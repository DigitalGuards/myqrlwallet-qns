# QNS: QRL Name Service

QNS is a Hyperion-native naming service for QRL 2.0. It keeps the stable ENS v1 registry model, uses native 64-byte QRL addresses, and adds post-quantum signing groundwork with SHAKE256 and ML-DSA-87.

Status: active QRL 2.0 migration work. The contracts compile only with the 64-byte Hyperion toolchain. A local `config/testnet.json` may retain the legacy 20-byte Testnet V2 (chain ID 1337) deployment as historical state; that file is ignored because deployment records can contain private infrastructure details. Use a fresh 64-byte network for new deployments.

`config/testnet-v3.example.json` identifies MyQRLWallet Testnet v3 (private), chain `3151909`, with its pinned genesis. Copy it to a separate ignored deployment configuration after deployment approval. The scripts verify chain and genesis before every write and retain the precompile capability checks. The example contains no deployed contract addresses. Preserve historical v2 records separately.

The QNS SDK supports Connect `>=5.0.1 <6.0.0` and its full-width account and RPC formats. Local tests include the published Connect provider's request/response path with a controlled in-memory transport; live wallet pairing and deployed-contract activation remain separate release gates.

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
app/                  Registration, wallet connection, owned names, and lookups
scripts/              Hyperion compilation, deployment, and integration checks
config/               Network configuration; deployment records stay local and ignored
docs/                 Protocol decisions, migration notes, and QIP groundwork
```

## Registration app

The React app in [`app/`](app/README.md) supports `.qrl` searches, wallet connection, confirmed registration and resolver setup, optional primary names, owned records, and forward/reverse lookups. It reads the same network JSON as the deploy script. The default v3 example displays deployment pending until contract addresses are supplied. See the app README for development, validation and the lead's deployment command.

Network configs accept `deploymentBlock`, a positive safe integer identifying the block in the QNSRegistry deployment receipt. The deploy script records that receipt block. Both undeployed examples use `1` as a placeholder, which deployment replaces. Older configs may omit the field: owned-name scans start at block 1 and the app warns that the list may be incomplete. Log requests start above genesis, use pages of at most 2,000 blocks, and shrink to endpoint range limits.

## Build and test

```bash
npm install
npm --prefix sdk install
npm test
```

The test command uses the central 64-byte compiler at `../hyperion/build/hypc/hypc`, verifies its exact version and SHA-256 against `config/hyperion-toolchain.json`, compiles every deployable contract through via-IR, runs the contract lint gate, executes the Q128 and `bytes32` mapping-accessor regression and the QNS contract suites under default and optimized legacy and via-IR codegen, runs the deployment-script unit tests, type-checks the SDK, and runs its unit tests. `HYPERION_COMPILER` and `HYPC_BIN` may select another path only when that binary has the reviewed identity. `npm run test:behavior` runs the live contract behavior suite against a deployed stack (it skips itself when `QNS_BEHAVIOR=1` is not set).

Worktrees can select the reviewed source tree with `HYPERION_SOURCE_DIR` and the semantic runner and VM with `HYPERION_HYPTEST` and `QRVMONE_LIBRARY`. Compiler version and SHA-256 verification still use the pinned toolchain file.

### Contract evidence gates

- `npm run lint:contracts` compiles every contract with the pinned compiler in all four codegen modes and fails on any compiler warning without a reviewed entry in `config/contract-lint-allowlist.json`. Its source rules forbid `tx.origin`, inline assembly, unchecked low-level call results, implicit visibility and Solidity or Foundry files, require one `pragma hyperion >=0.0;` per file, and require an event on every public state change. Each allowlist entry carries a reason and a fingerprint of the exact code it covers, so new or changed findings fail. `npm run lint:contracts:source` runs the source rules alone; CI runs it.
- `npm run test:semantic` runs the hyptest suites in `test/hyperion/semantic/`: every external function of the registry, Root, the resolver, the reverse registrar, the FIFS registrar and the signature verifier, their revert data, events and authorization matrices, 64-byte address edge cases, the SDK vectors from `sdk/src/fixtures/qns-vectors.json`, and real ML-DSA-87 vectors. The suites run on a test host built under `build/evidence/` from the pinned hyptest objects: it verifies slot 3 frames with `@theqrl/mldsa87` and drops the logs of reverted frames.
- `npm run fuzz` checks that the fuzzer catches eight planted model faults, then runs 300 seeded sequences in each codegen mode. `npm run fuzz:long` runs 20,000 sequences of 30 steps on the deployed via-IR build. Both compare every call's status, return data and logs, and 423 observable views after every step, with a JavaScript reference model; a mismatch prints the seed, a replay command and a minimised sequence. `--sequences`, `--length`, `--seed` and `--jobs` (or `QNS_FUZZ_SEQUENCES`, `QNS_FUZZ_LENGTH`, `QNS_FUZZ_SEED`, `QNS_FUZZ_JOBS`) adjust a run.

Build Hyperion with Z3 support and run the reproducible formal security gate with:

```bash
HYPERION_FORMAL_COMPILER=../hyperion/build-formal/hypc/hypc npm run verify:formal
```

The gate currently proves 37 CHC and 24 BMC targets covering the cryptographic boundary, exact QNS context bytes, resolver capabilities, unauthorized transitions, 64-byte reverse-index arithmetic, registry authority and frame conditions, Controllable and Ownable effects, and the resolver record version, and it requires nine reachability witnesses so no BMC property holds vacuously. See [`docs/FORMAL-SECURITY-VERIFICATION.md`](docs/FORMAL-SECURITY-VERIFICATION.md) for the threat model, exact claims, evidence classes, and assumptions.

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
npm run compile
QNS_CONFIG=config/local-qip55.json npm run deploy:testnet
```

Select one of the public development accounts supplied by the Kurtosis package without copying its seed into your shell:

```bash
QNS_CONFIG=config/local-qip55.json QNS_PUBLIC_DEV_ACCOUNT=0 npm run deploy:testnet
QNS_PUBLIC_DEV_ACCOUNT=0 npm run register -- alice
npm run verify:pq
```

The local config must declare `"qrl2PrecompileSet": "qrl2-pq-v1"`. Deployment verifies the exact compiler, source, ABI, and bytecode hashes, checks the chain ID, and executes live 64-byte ML-DSA-87 slot 3 plus SHAKE256 slot 6 probes before its first transaction. The command-scoped public account selector is accepted only when the configured RPC URL has a loopback host and the connected chain ID matches the pinned local chain. Chain `3151908` is the default; set `QNS_PUBLIC_DEV_CHAIN_ID` in the same command when a fresh isolated enclave deliberately uses another chain ID. When explicitly set, the selector takes precedence over a `TESTNET_SEED` in the ignored `.env`. Keep both public-development selectors out of persistent `.env` files. Use `TESTNET_SEED` for other development networks. Never put a private seed in tracked files or shell history.

The initial deployment account remains the owner of `Root`, a Root controller, and the owner of `ReverseRegistrar`. Treat that account as an alpha administrator until the community selects a governance owner and an explicit controller-revocation plus ownership-transfer procedure. Do not renounce these roles before verifying the complete handoff on the target network.

Validated locally on 2026-08-26: the execution, beacon, and validator services produced blocks with chain ID `3151908` and genesis activation `qrl2PQPrecompilesTime: 0`. Six current Hyperion contracts deployed. A fresh `.qrl` name passed forward resolution, reverse resolution, and forward confirmation through the SDK. All nine direct and wrapped PQ checks passed, including the SHAKE256 vector, valid and invalid ML-DSA-87 calls, mutated digest and public-key rejection, context lengths 0 and 255, cross-context rejection, and the exact 64-byte digest boundary. The live Hyperion behavior suite passed its eight lifecycle and authorization subtests. Every observed Kurtosis host mapping was loopback-only, and block height advanced during the final health probe. The validated enclave and RPC proxy were subsequently stopped to release host resources.

## License

GPL-3.0. The Hyperion files under `contracts/hyperion/vendored/` retain the upstream ENS and OpenZeppelin notices applicable to their source.
