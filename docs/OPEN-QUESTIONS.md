# Open Questions Blocking QNS Implementation

Seven load-bearing unknowns for Phase 1 deployment. Status column updated 2026-04-21.

| # | Question | Status |
|---|---|---|
| 1 | Hyperion `address` type width | **ANSWERED** (20 bytes, verified in source) |
| 2 | ML-DSA-87 verification precompile | Waiting for dev input |
| 3 | Testnet V2 chainId | **ANSWERED** (1337 = `0x539`, verified via RPC) |
| 4 | `msg.sender` bytes: include descriptor? | Unknown (follow-up on Q1 finding) |
| 5 | TLD choice | **ANSWERED** (`.qrl` per user 2026-04-21, still needs QIP to formalize) |
| 6 | `ecrecover` retained on Zond? | **ANSWERED** (removed per QRL dev: "ECDSA has NO place") |
| 7 | `zondjs` readiness vs direct `@theqrl/qrl_providers` | User building own SDK in `myqrlwallet-connect`; target providers directly |

---

## 1. Hyperion `address` type width: ANSWERED (20 bytes)

**Finding (2026-04-21):** Hyperion preserves the 20-byte Solidity `address` type.

Verified in `/home/waterfall/myqrlwallet/hyperion/libhyperion/ast/Types.h:455-456`:

```cpp
unsigned calldataEncodedSize(bool _padded = true) const override { return _padded ? 32 : 160 / 8; }
unsigned storageBytes() const override { return 160 / 8; }
```

`160/8 = 20`. Storage and unpadded-calldata sizes are both 20 bytes, matching Ethereum. Padded size is 32 bytes (EVM word), also matching.

**Implication:** Vendored ENS contracts compile unmodified. Path A (dual-stack resolver) works cleanly:
- `msg.sender` on-chain is the 20-byte EVM address.
- Wallet-displayed 24-byte "Q-prefixed" address format is a wallet-layer representation (likely descriptor + EVM address), not the EVM `address` type.
- `addr(bytes32) returns (address)` returns the real 20-byte EVM address, not a "lossy shim".
- `qrlAddr(bytes32) returns (bytes)` stores the full 24-byte wallet-display form when a user wants the display-format preserved.

The Q4 descriptor question becomes: "how does the 20-byte EVM `msg.sender` relate to the 24-byte wallet-display form?" (i.e., is the 24-byte form `[descriptor][20-byte-evm-address][?]` or something else?). That's now the remaining address-layer open question.

## 2. ML-DSA-87 verification precompile

**Q:** Is there a precompile on Zond for ML-DSA-87 signature verification? If yes: at what address, with what ABI, at what gas cost?

**Status:** Waiting for QRL dev input.

**Affects:** Phase 4 (signed records, ENSIP-19 sig reverse, CCIP-Read) is tractable with a precompile and infeasible without one.

**How to resolve:** Grep `/home/waterfall/myqrlwallet/go-qrl` for `PrecompiledContract` registrations and MLDSA references. Ask QRL core-devs. If missing, open a QIP proposing inclusion before mainnet freeze.

## 3. Testnet V2 chainId: ANSWERED (1337)

**Finding (2026-04-21):** `qrl_chainId` returns `0x539` = 1337 on `https://qrlwallet.com/api/qrl-rpc/testnet`.

```bash
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"qrl_chainId","params":[],"id":1}' \
  https://qrlwallet.com/api/qrl-rpc/testnet
# → {"jsonrpc":"2.0","id":...,"result":"0x539"}
```

**Derived:** ENSIP-11 coinType for Testnet V2 = `0x80000000 | 1337` = `0x80000539`.

**Mainnet chainId:** Still unknown. Must confirm before Phase 5 mainnet deployment.

## 4. On-chain address representation: descriptor relationship to 20-byte EVM address

**Q (refined post-Q1 finding):** The EVM `address` is 20 bytes. The wallet-displayed QRL address is 24 bytes (Q-prefix + 40-hex = 20 bytes of the display, plus 3-byte descriptor held separately). What is the exact mapping between the 20-byte EVM address and the 24-byte wallet-display bytes?

**Possibilities:**
- (a) The 20-byte EVM address is the **last 20 bytes of the 24-byte wallet form**, with the 3-byte descriptor prepended at the wallet layer.
- (b) The 24-byte wallet form is independent (hash or derivation) and maps to a 20-byte EVM address via a well-defined function.
- (c) Something else.

**Affects:** Whether `qrlAddr(bytes32) returns (bytes)` stores the 24-byte form or derives it from the 20-byte EVM address, and how the reverse-namespace `sha3QRLAddress` works.

**How to resolve:** Inspect `/home/waterfall/myqrlwallet/go-qrl/common/address.go` or equivalent for the address-format definition. Deploy a trivial `contract T { function me() view returns (address) { return msg.sender; } }` and compare its return to the wallet's displayed address for the same signer.

## 5. TLD choice: ANSWERED (.qrl)

**Decision (2026-04-21, user):** `.qrl`.

Aligns with post-Zond rebrand, unambiguous. FIFS registrar in Phase 1 will own the `.qrl` label in the root registry.

**Still outstanding:** Formalize via QIP under the QEP track. Coordinate with QIP custodians (jackalyst, fr1t2, jplomas). This can happen in parallel with Phase 1 contract development.

## 6. ecrecover on Zond: ANSWERED (removed)

**Finding (2026-04-21, per QRL dev):** "ECDSA has NO place" on Zond. The `ecrecover` precompile (`0x01`) is removed. Keccak256 and SHA3 remain.

**Implication:** Vendored ENS code that uses `ECDSA.recover` (OpenZeppelin, ENSIP-19 signature reverse) will **not** link. Audit vendored contracts for any `ecrecover` use:

- `ENSRegistry.sol`, `Root.sol`, `PublicResolver.sol`, `ReverseRegistrar.sol`, `UniversalResolver.sol` — all use `msg.sender` only. Should port cleanly.
- `SignatureReverseRegistrar` / ENSIP-19 signature variants — use `ecrecover`. **Must be replaced** with ML-DSA-87 verification (Phase 4, contingent on precompile).
- OpenZeppelin `ECDSA.recover` consumers — not used in the minimal QNS vendoring scope.

**Phase 4 consequence:** Without `ecrecover`, *and* without an ML-DSA precompile, ENSIP-19 signature-based reverse cannot be implemented on-chain cheaply. Fallback: CCIP-Read-style off-chain signed gateway, or defer signature-based reverse indefinitely and rely on `msg.sender`-based `setName()`.

## 7. SDK target: ANSWERED (`@qrlwallet/connect` v2+, EIP-1193)

**Finding (2026-04-21 updated):** `@qrlwallet/connect` v2.0.0 is the primary browser/mobile provider. `@theqrl/qrl_providers` is considered outdated for QNS's use case; `zondjs` is not the target either.

`@qrlwallet/connect` (`/home/waterfall/myqrlwallet/myqrlwallet-connect`, `DigitalGuards/myqrlwallet-connect`) exports `QRLConnectProvider` which:
- Implements EIP-1193 `request({method, params})` directly
- Opens a post-quantum (ML-KEM-768) encrypted Socket.IO session via `qrlwallet.com/relay`
- Forwards all `qrl_*` and `eth_*` RPC calls to MyQRLWallet mobile app
- No `window.qrl` extension dependency

**Implication:** `@qns/sdk` stays EIP-1193-agnostic (`RpcProvider.request(...)`). `@qrlwallet/connect` is listed as the recommended primary provider in `sdk/README.md`, but kept as an *optional* peer-dep — server-side callers (gqrl RPC proxy, CCIP-Read gateway) may use neither.

---

## Secondary (non-blocking) questions

| # | Question | Recommendation | Status |
|---|---|---|---|
| 8 | ENSv2 per-name sub-registry architecture — adopt or skip? | Skip; v1 is stable | Decided |
| 9 | XMSS pubkey support alongside ML-DSA in `IPubkeyResolver`? | ML-DSA only | Decided |
| 10 | Tokenize names as QRC-721 from day one? | No; defer to Phase 5+ | Decided |

---

## Resolution log

```
2026-04-21  Q1 answered: Hyperion preserves 20-byte address (source inspection, libhyperion/ast/Types.h:455-456)
2026-04-21  Q3 answered: chainId 1337 (qrl_chainId RPC call returned 0x539)
2026-04-21  Q5 answered: TLD = .qrl (user decision, QIP pending)
2026-04-21  Q6 answered: ecrecover removed on Zond (QRL dev: "ECDSA has NO place")
2026-04-21  Q7 answered: SDK targets @qrlwallet/connect v2 (post-quantum ML-KEM-768 session, EIP-1193); @theqrl/qrl_providers deprecated for QNS
```
