# QNS Roadmap

Phase targets are best-effort; gating factors are called out per phase. Dates assume work starts once the Phase 1 open questions (see `OPEN-QUESTIONS.md`) are resolved.

## Phase 0 — Alpha scaffolding *(this milestone)*

**Goal:** repository, docs, toolchain skeleton, port plan published.

- [x] GitHub repo `DigitalGuards/myqrlwallet-qns` created, added to workspace as submodule.
- [x] Foundry + Hyperion directory layout matching `QuantaPool` conventions.
- [x] SDK skeleton with working `namehash()`.
- [x] Docs: port plan, address-compat, crypto-integration, roadmap, open questions.
- [ ] QIP draft submitted to `theQRL/qips` (post-scaffolding).

## Phase 1 — Forward resolution on Testnet V2

**Target:** 4–6 weeks after open-questions resolved.
**Gating:** Hyperion `address` type width, chainId, descriptor bytes (OPEN-QUESTIONS #1, #3, #4).

- Vendor `ensdomains/ens-contracts` at a pinned Q4 2025 commit under `contracts/solidity/vendored/`.
- Deploy: `ENSRegistry`, `Root`, `FIFSQRLRegistrar` (owning `.qrl`), `PublicResolver` with `IQRLAddrResolver` profile.
- Exclude: NameWrapper, `ETHRegistrarController`, `BaseRegistrarImplementation`, DNSSEC.
- SDK: `resolveName(name) → bytes24` via registry-walk → resolver → `qrlAddr(node)`.
- Validation: register 5+ test names via FIFS; round-trip resolve from the sample dApp.

**Output:** deployable contracts, published `@qns/sdk` alpha, one-page demo.

## Phase 2 — Reverse resolution + UniversalResolver

**Target:** 3–4 weeks after Phase 1.
**Gating:** none (builds on Phase 1).

- Deploy `ReverseRegistrar`, wire `addr.reverse` per ENSIP-19 per-chain form with QRL Zond coinType `0x80000000 | chainId`.
- Deploy `UniversalResolver` with stub batch-gateway provider.
- SDK: `lookupAddress(qrlAddr) → string` with ENS-mandated forward-confirm.
- Defer signature-based `setNameForAddrWithSignature` to Phase 4 — basic `setName` path uses `msg.sender` (no ML-DSA needed).

**Output:** primary-name support end-to-end, single-RPC UniversalResolver lookups.

## Phase 3 — Records: text, contenthash, multichain

**Target:** 2–3 weeks.
**Gating:** none.

- Enable `ITextResolver` (EIP-634: avatar, email, url, com.twitter, …).
- Enable `IContentHashResolver` (EIP-1577).
- Enable `IAddressResolver` multichain (EIP-2304 / ENSIP-9) — publish QRL Zond coinType guidance.
- SDK: `getText` / `setText`, `getContenthash` / `setContenthash`.

**Output:** feature parity with ENS for record retrieval. Sufficient for dApp avatar display + IPFS content routing.

## Phase 4 — ML-DSA signed records + post-quantum identity

**Target:** 6–8 weeks.
**Gating:** ML-DSA precompile availability (OPEN-QUESTIONS #2). If unavailable, scope shrinks to in-EVM verifier or CCIP-Read only.

- `QRLSignatureVerifier` contract (precompile wrapper or in-EVM fallback).
- ENSIP-19 `setNameForAddrWithSignature` ported to ML-DSA-87.
- CCIP-Read gateway: off-chain signed resolver records (EIP-3668 + EIP-5559).
- **`IPubkeyResolver` profile — QNS extension beyond ENS.** Publish ML-DSA-87 pubkeys (2,592 bytes) as first-class resolver records, indexed by name. Enables dApp-signed actions, verifiable credentials, gossip-network identity.

**Output:** post-quantum identity primitive. This is the phase that makes QNS more than "ENS on Zond".

## Phase 5 — Mainnet + economics

**Target:** tied to QRL Zond mainnet launch.
**Gating:** mainnet chainId, QRC-721 standard status, QIP acceptance.

- Replace `FIFSQRLRegistrar` with commit/reveal registrar (pricing, grace period, renewals).
- Pricing in QRL (Planck/Shor sub-units).
- QIP formalizing QNS as ecosystem standard.
- Optional: tokenize names as QRC-721 once that standard stabilizes.

**Output:** production QNS on QRL Zond mainnet.

## Non-goals (not in roadmap)

- **ENSv2 per-name sub-registry architecture** — spec unfinalized, moving target. Stay on v1 monolithic registry.
- **NameWrapper / fuses** — adds attack surface orthogonal to post-quantum naming.
- **DNSSEC oracle integration** — out of scope.
- **Namechain L2** — cancelled by ENS Labs Feb 2026.

## Cross-workspace touchpoints

- **`myqrlwallet-frontend`** — consume `@qns/sdk` for address-book name resolution once Phase 1 ships.
- **`myqrlwallet-connect`** — dApp-connect SDK can advertise QNS capability in session metadata.
- **`zondscan`** — display QNS names in tx/address views once reverse resolution (Phase 2) is live.
- **`QuantaPool`** — potential consumer for validator identity (publish validator ML-DSA pubkey as a QNS record) in Phase 4+.
