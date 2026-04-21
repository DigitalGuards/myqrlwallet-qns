# CLAUDE.md: QNS (myqrlwallet-qns)

Operating rules for Claude sessions in `/home/waterfall/myqrlwallet/myqrlwallet-qns`. The workspace-wide rules at `/home/waterfall/myqrlwallet/CLAUDE.md` still apply; this file adds QNS-specific context.

## What this repo is

QNS (QRL Name Service) is the post-quantum port of ENS v1 to QRL Zond. Three conceptual layers:

- **Contracts** (`contracts/solidity/`): vendored + minimally-patched copy of `ensdomains/ens-contracts@v1.6.2`. New code: `FIFSQRLRegistrar`, `QRLPublicResolver`, `IQRLAddrResolver` profile (Path A dual-stack addresses). NameWrapper, BaseRegistrarImplementation, ETHRegistrarController, DNSSEC tooling are **excluded**.
- **SDK** (`sdk/`): `@qns/sdk` TypeScript library. Uses `@noble/hashes` for keccak256, provider-agnostic EIP-1193 (primary provider: `@qrlwallet/connect` v2 at `../myqrlwallet-connect`), `@theqrl/mldsa87` for Phase 4 signed records.
- **Docs** (`docs/`): port plan, address-compatibility design, crypto integration, roadmap, open questions.

## Status (2026-04-21)

**Phase 2 LIVE on Testnet V2.** Forward + reverse resolution working end-to-end via Hyperion-compiled contracts. See `config/testnet.json` for addresses.

- Phase 0 (scaffolding): done
- Phase 1 (forward resolution): done, SDK `resolveName` live
- Phase 2 (reverse resolution): done, SDK `lookupAddress` + `verifyReverse` live
- Phase 3 (records: text, contenthash, multichain): next
- Phase 4 (ML-DSA signed records): unblocked (Cyyber confirmed precompile exists, docs by 2026-04-28)
- Phase 5 (mainnet + commit/reveal registrar): gated on mainnet chainId

## Network / chain

- QRL Zond Testnet V2: **chainId `1337`** (confirmed via `qrl_chainId` RPC; coinType `0x80000539` per ENSIP-11).
- RPC proxy: `https://qrlwallet.com/api/qrl-rpc/testnet`. Filters `eth_*`; use `qrl_*` namespace.
- Address format: `Q` prefix + 40 hex displayed; EVM `msg.sender` is 20 bytes (Hyperion preserves the Solidity type per `libhyperion/ast/Types.h:455-456`). How the 24-byte wallet display form relates to the 20-byte EVM form is still open (see `docs/OPEN-QUESTIONS.md` Q4).

## Toolchain

- **Foundry** (`forge build` / `forge test`): canonical test suite (21 tests covering forward + reverse). Drives CI.
- **Hyperion** (`npm run compile:hyperion`): canonical deployment path per QRL team recommendation. `scripts/sync-hyperion.js` walks `contracts/solidity/` preserving nested dirs, rewrites `@openzeppelin/`/`@ensdomains/` imports to relative `.hyp` paths, translates unit suffixes (`ether->quanta`, `gwei->shor`, `wei->planck`) and 40-hex `0x` address literals to `Q` prefix. `scripts/compile-hyperion.js` drives `hypc`.
- **Deploy** (`npm run deploy:testnet`): reads `build/hyperion/*.{abi,bin}` by default. `BUILD=foundry` env flips to `out/*.json`. Uses `../QuantaPool`'s `encodeABI` + `web3.qrl.sendTransaction` pattern because `Contract(abi, addr)` doesn't inherit the wallet.
- **SDK** (`npm --prefix sdk run build` / `npm --prefix sdk test`): tsc strict + vitest. `dist/` is gitignored; rebuild before running `register-and-resolve.js`.

## ENS vendoring rules

- Pin: `ensdomains/ens-contracts@v1.6.2`, commit `3d477d4`, 2025-12-08. Recorded in `contracts/solidity/vendored/README.md`.
- Vendored Solidity lives under `contracts/solidity/vendored/`. Upstream `LICENSE.txt` is copied verbatim.
- **Touch vendored files minimally.** Every diff vs upstream is tracked in `contracts/solidity/vendored/DIFFS.md`.
- Custom contracts (`FIFSQRLRegistrar`, `QRLPublicResolver`, `IQRLAddrResolver` profile) live outside `vendored/` in the normal directory tree.
- OpenZeppelin replacements (`Ownable`, `ERC165`, `IERC165`) are in-tree at `vendored/openzeppelin/` so Hyperion syncs cleanly without a submodule.

## Address representation (Path A, implemented)

- Primary forward record: `qrlAddr(bytes32) returns (bytes)`, stores the 24-byte QRL wallet-display form.
- Legacy `addr(bytes32) returns (address)` returns the 20-byte EVM form. Not a shim of the 24-byte form; it's the actual `msg.sender`-style address.
- `IAddressResolver` multichain `addr(bytes32, uint256) returns (bytes)` is Phase 3 (not implemented yet).
- Reverse namespace uses **standard ENSIP-19** `sha3HexAddress(20-byte)` — Hyperion's `address` is 20 bytes, so no custom `sha3QRLAddress` is needed.

See `docs/ADDRESS-COMPATIBILITY.md`.

## ML-DSA-87 integration

- **Off-chain signing only** (Phase 4). Inside the EVM, keccak256 + `msg.sender` do all the work; no `ecrecover`-shaped verification in Phase 1/2/3 paths. This matters because `ecrecover` is **removed** on Zond ("ECDSA has NO place" per QRL dev).
- `@theqrl/mldsa87` v1.1.1 with context `"ZOND/QNS/v1"` for domain separation.
- **Precompile confirmed** (2026-04-21, Cyyber) — details coming 2026-04-28. Plan is `QRLSignatureVerifier.sol` wrapping the precompile; no in-EVM verifier needed.
- ML-DSA signatures are **4,627 bytes** and pubkeys are **2,592 bytes**: never store raw signatures on-chain. Design records around off-chain storage with on-chain namehash pointers; publish pubkeys as resolver records indexed by name.

See `docs/CRYPTO-INTEGRATION.md`.

## Sensitive areas (don't change without explicit ask)

- `contracts/solidity/vendored/` — pinned upstream copy; bump tracked via `DIFFS.md`.
- `docs/OPEN-QUESTIONS.md` — answered questions keep historical context; do not delete entries even after resolution.
- `config/testnet.json` `contracts` map — live deployed addresses. Overwriting orphans on-chain state (previous generations are kept in `previousContracts`).
- `.env` — production-grade secret even on testnet.

## Remaining open questions (see `docs/OPEN-QUESTIONS.md`)

- **Q4** (address mapping): how does the 24-byte wallet-display form relate to the 20-byte EVM `msg.sender`? Not blocking reverse lookup (we use the 20-byte EVM form) but needed for UX where users see 24-byte displays.
- **Q2 follow-ups**: precompile address / ABI / gas / batch-verify semantics — pending docs drop 2026-04-28.

## Related workspace repos

- `../QuantaPool` — Foundry + Hyperion toolchain reference; script patterns borrowed.
- `../myqrlwallet-connect` — `@qrlwallet/connect` v2, the primary SDK provider target.
- `../myqrlwallet-frontend` — consumer of `@qns/sdk` for address-book name resolution (Phase 3 integration).
- `../zondscan` — would display QNS names in tx/address views once reverse resolution is wired.
