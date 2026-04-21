# CLAUDE.md — QNS (myqrlwallet-qns)

Operating rules for Claude sessions in `/home/waterfall/myqrlwallet/myqrlwallet-qns`. The workspace-wide rules at `/home/waterfall/myqrlwallet/CLAUDE.md` still apply; this file adds QNS-specific context.

## What this repo is

QNS (QRL Name Service) is the post-quantum port of ENS v1 to QRL Zond. Three conceptual layers:

- **Contracts** (`contracts/solidity/`) — vendored + minimally-patched copy of `ensdomains/ens-contracts`. New code: `FIFSQRLRegistrar`, `IQRLAddrResolver` profile (Path A dual-stack addresses). NameWrapper, BaseRegistrarImplementation, ETHRegistrarController, DNSSEC tooling are **excluded** from the initial port.
- **SDK** (`sdk/`) — `@qns/sdk` TypeScript library. Uses `@theqrl/qrl_providers` for wallet/RPC, `@noble/hashes` for keccak256, `@theqrl/mldsa87` for any signed records.
- **Docs** (`docs/`) — full port plan, address-compatibility design, crypto integration, roadmap, open questions. Start here before writing code.

## Status

**Alpha scaffolding.** No real Solidity yet — directories are placeholders until Phase 1 vendoring lands. Do not assume any contract is real until `contracts/solidity/vendored/README.md` says "pinned and copied".

## Network / chain

- QRL Zond Testnet V2 — **chainId `1337`** (same as QuantaPool's current testnet setup). The old `32382` is pre-rebrand and should not appear against current testnet.
- RPC proxy: `https://qrlwallet.com/api/qrl-rpc/testnet` — filters `eth_*`, use `qrl_*` namespace.
- Address format: `Q` prefix + 40-hex displayed; 24-byte native under the hood with 3-byte descriptor stored separately (post April-2025 go-qrllib refactor). See `docs/ADDRESS-COMPATIBILITY.md`.

## Toolchain

- **Foundry:** `forge build`, `forge test`. Canonical — keep green once Phase 1 sources exist.
- **Hyperion:** `contracts/hyperion/` holds auto-synced `.hyp` mirrors. Sync + compile scripts will be ported from `../QuantaPool/scripts/sync-hyperion.js` and `../QuantaPool/scripts/compile-hyperion.js` when Solidity sources land.
- **SDK:** `npm --prefix sdk run build` (tsc strict mode), `npm --prefix sdk test` (vitest).

## ENS vendoring rules

- Pin `ensdomains/ens-contracts` to a **Q4 2025 commit** (pre-ENSv2, post-ENSIP-19). Record the commit SHA + reasoning in `contracts/solidity/vendored/README.md`.
- Vendored Solidity lives under `contracts/solidity/vendored/` with upstream license text preserved.
- **Touch vendored files minimally.** Every diff vs upstream is documented in `contracts/solidity/vendored/DIFFS.md` (to be created in Phase 1).
- Custom contracts (`FIFSQRLRegistrar`, `IQRLAddrResolver` profile, etc.) live outside `vendored/` in the normal directory tree.

## Address representation (Path A)

- Primary forward-resolution record: `qrlAddr(bytes32) returns (bytes)` — native 24-byte QRL address.
- Legacy `addr(bytes32) returns (address)` retained as compatibility shim returning the 20-byte tail.
- Multichain via EIP-2304 `addr(bytes32, uint256) returns (bytes)` using an ENSIP-11-derived coinType for QRL Zond (`0x80000000 | chainId`).
- Reverse namespace uses per-chain form `[coinTypeHex].reverse` (ENSIP-19) with `sha3QRLAddress` (keccak256 of 48-char lowercase hex, no `Q`/`0x` prefix, no descriptor).

See `docs/ADDRESS-COMPATIBILITY.md` for rationale and rejected alternatives (Path B Hyperion type redefinition, Path C descriptor strip).

## ML-DSA-87 integration

- **Off-chain signing only.** Inside the EVM, keccak256 + `msg.sender` checks do all the work — no `ecrecover`-shaped verification is needed for basic resolution.
- `@theqrl/mldsa87` v1.1.1 with context `"ZOND/QNS/v1"` for domain separation.
- Signed records (ENSIP-19 sig reverse, EIP-5559 off-chain writes, CCIP-Read) require either an ML-DSA precompile (open question — see `docs/OPEN-QUESTIONS.md`) or an in-EVM verifier (expensive, ~5-10M gas).
- ML-DSA signatures are **4,627 bytes** and pubkeys are **2,592 bytes** — do not try to store raw signatures on-chain. Design records around off-chain storage with on-chain namehash pointers.

See `docs/CRYPTO-INTEGRATION.md`.

## Sensitive areas (don't change without explicit ask)

- `contracts/solidity/vendored/` — pinned upstream copy; regenerate in a tracked way if upgrading the pin.
- `docs/OPEN-QUESTIONS.md` — 7 load-bearing unknowns that block contract deployment. Only remove an item when its resolution is merged.
- `config/testnet.json` `contracts` map — once populated, overwriting orphans on-chain state.
- `.env` — production-grade secret even on testnet.

## Phase 1 gate (before deploying anything)

Answer at least these four from `docs/OPEN-QUESTIONS.md`: Hyperion `address` type width, ML-DSA precompile availability + gas, Testnet V2 chainId (should be `1337` but confirm), descriptor inclusion in on-chain `msg.sender` bytes. The TLD choice (`.qrl` vs alternatives) can be deferred but should go through a QIP.

## Related workspace repos

- `../QuantaPool` — Foundry + Hyperion toolchain reference; copy script patterns.
- `../myqrlwallet-frontend` — Future consumer of `@qns/sdk` for address-book name resolution.
- `../myqrlwallet-connect` — dApp-connect SDK; could advertise QNS resolution capability to dApps.
