# QNS Roadmap

Live status as of 2026-04-21. Per-phase gating factors called out explicitly.

## Phase 0: Alpha scaffolding — **COMPLETE**

- [x] GitHub repo `DigitalGuards/myqrlwallet-qns` created, added to workspace as submodule.
- [x] Foundry + Hyperion directory layout matching `QuantaPool` conventions.
- [x] SDK skeleton with working `namehash()`.
- [x] Docs: port plan, address-compat, crypto-integration, roadmap, open questions.
- [ ] QIP draft submitted to `theQRL/qips` (still pending; non-blocking).

## Phase 1: Forward resolution on Testnet V2 — **COMPLETE**

Shipped 2026-04-21. All 5 open-question gates answered or resolved.

- [x] Vendored `ensdomains/ens-contracts@v1.6.2` (commit `3d477d4`) under `contracts/solidity/vendored/`.
- [x] Deployed: `ENSRegistry`, `Root`, `FIFSQRLRegistrar` (owns `.qrl`), `QRLPublicResolver` (with `IQRLAddrResolver` profile).
- [x] Excluded: NameWrapper, `ETHRegistrarController`, `BaseRegistrarImplementation`, DNSSEC (per plan).
- [x] SDK: `resolveName(name) -> bytes24` walking registry -> resolver -> `qrlAddr(node)`.
- [x] Validation: `alice.qrl` and `bob.qrl` registered via FIFS; round-trip resolve through SDK against live testnet.
- [x] Deploy path via Hyperion (`hypc`) as canonical; solc bytecode works but Hyperion is the QRL-team-recommended mainnet path.

**Live addresses** (in `config/testnet.json`):
- `ENSRegistry`: `Qd812032246Fc1e53f5eC392c325b1B4A8C0C2f92`
- `Root`: `Qd973B4504D432916650EB26A83bCB1E0cbE6Bb4B`
- `FIFSQRLRegistrar`: `Qcc731b748292BA5af2F49F342783986fAe6C68F6`
- `QRLPublicResolver`: `Q77008762334bE497f61722d74115B91A70bBfD91`

## Phase 2: Reverse resolution — **COMPLETE**

Shipped 2026-04-21 alongside Phase 1 redeploy.

- [x] `ReverseRegistrar` vendored + OZ-v5 patched. Deployed and assigned `addr.reverse`.
- [x] `QRLPublicResolver` extended with `INameResolver` (`name` / `setName`) and a `trustedReverseRegistrar` constructor arg so reverseRegistrar can write reverse records.
- [x] SDK: `lookupAddress(addrHex) -> string` walking registry -> resolver -> `name(reverseNode)` using standard ENSIP-19 `sha3HexAddress` (keccak of 40-char lowercase hex of 20-byte address).
- [x] SDK: `verifyReverse(addrHex) -> string | null` performs forward-confirm against legacy `addr(bytes32)` before returning.
- [x] Validation: `alice.qrl` reverse set for deployer address; round-trip through SDK end-to-end.

**Live reverse registrar**: `QF1f50E5b74671Ef90Bc515d3beb46d2Ea55e7a70`.

UniversalResolver (single-RPC multi-call) **deferred** to Phase 3 — not needed for alpha UX; useful once we have batch read patterns.

## Phase 3: Records: text, contenthash, multichain — **Next**

**Target:** 1-2 weeks.
**Gating:** none.

The resolver already implements `ITextResolver` and `IContentHashResolver` — they're tested but not exercised end-to-end on testnet. Remaining work:

- [ ] `IAddressResolver` multichain `addr(bytes32, uint256)` implementation on `QRLPublicResolver`.
- [ ] SDK: `getText` / `setText`, `getContenthash` / `setContenthash`, `getMultichainAddr(name, coinType)`.
- [ ] Integration tests on testnet: text, contenthash, multichain records.
- [ ] (Optional) UniversalResolver deployment for batch reads.
- [ ] SLIP-44 / ENSIP-11 coinType guidance for QRL Zond (`0x80000539` testnet; mainnet TBD).

**Output**: feature parity with ENS for record retrieval. Sufficient for dApp avatar display + IPFS content routing.

## Phase 4: ML-DSA signed records + post-quantum identity — **Unblocked**

**Target:** 4-6 weeks.
**Gating:** precompile docs drop (expected 2026-04-28 from Cyyber).

Cyyber confirmed 2026-04-21 that Zond has ML-DSA-87 verification precompile(s). Docs with address / ABI / gas are in progress. Once they land:

- [ ] `QRLSignatureVerifier.sol` wrapping the precompile.
- [ ] `SignatureReverseRegistrar.sol` — ENSIP-19 `setNameForAddrWithSignature` ported to ML-DSA-87.
- [ ] CCIP-Read gateway (EIP-3668 + EIP-5559): off-chain signed records.
- [ ] `IPubkeyResolver` profile — **QNS extension beyond ENS.** Publish ML-DSA-87 pubkeys (2,592 bytes) as first-class resolver records indexed by name. Enables dApp-signed actions, verifiable credentials, gossip-network identity.
- [ ] SDK helpers for signing via `@theqrl/mldsa87` with context `"ZOND/QNS/v1"`.

**Output**: post-quantum identity primitive. This is the phase that makes QNS meaningfully more than "ENS on Zond".

## Phase 5: Mainnet + economics

**Target**: tied to QRL Zond mainnet launch.
**Gating**: mainnet chainId commitment, QRC-721 standard status, QIP ratification.

- [ ] Replace `FIFSQRLRegistrar` with commit/reveal registrar (pricing, grace period, renewals).
- [ ] Pricing denominated in QRL (sub-units Planck/Shor per the roadmap rebrand).
- [ ] QIP formalizing QNS as ecosystem standard (custodians: jackalyst / fr1t2 / jplomas).
- [ ] Optional: tokenize names as QRC-721 once that standard stabilizes.

**Output**: production QNS on QRL Zond mainnet.

## Non-goals (not in roadmap)

- **ENSv2 per-name sub-registry architecture**: spec unfinalized, moving target. Stay on v1 monolithic registry.
- **NameWrapper / fuses**: adds attack surface orthogonal to post-quantum naming.
- **DNSSEC oracle integration**: out of scope.
- **Namechain L2**: cancelled by ENS Labs Feb 2026.

## Cross-workspace touchpoints

- **`myqrlwallet-frontend`**: consume `@qns/sdk` for address-book name resolution. Wire in Phase 3 once records flow end-to-end.
- **`myqrlwallet-connect`**: already the primary SDK provider via `QRLConnectProvider` (EIP-1193). Could advertise QNS capability in dApp session metadata.
- **`zondscan`**: display QNS names in tx/address views. Blocked on zondscan indexing `NameChanged` events (Phase 2 ready).
- **`QuantaPool`**: consumer for validator identity — publish ML-DSA validator pubkey as a QNS pubkey record once Phase 4 ships.
