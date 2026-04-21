# Crypto Integration: ML-DSA-87 for Signed Records

## Scope

**Inside the EVM** nothing changes. keccak256 is available on Hyperion/QRVM, and ownership in ENS/QNS core paths is enforced by `msg.sender` — which Zond already verifies at consensus using ML-DSA-87 transaction signatures. No `ecrecover` appears in a QNS registry/resolver write path.

**Off-chain** there are three signing surfaces inherited from ENS that need reimplementation against ML-DSA-87:

1. **ENSIP-19 signature-based reverse** (`setNameForAddrWithSignature`, selector `0x2023a04c`) — user signs a message, contract verifies with `ecrecover`.
2. **EIP-5559 / ERC-7700 off-chain writes** — client signs record update, gateway relays.
3. **CCIP-Read (EIP-3668)** — resolver reverts with `OffchainLookup`, client fetches signed gateway response.

## Library

- [`@theqrl/mldsa87`](https://www.npmjs.com/package/@theqrl/mldsa87) v1.1.1.
- Code-frozen 2026-02-13. Halborn-audited 2026-03-31 — all 13 informational findings resolved.
- Commit `58db119` + remediation commits `1661eca`, `f9fb304`, `2c4335b`, `201e2e3`.

### API shape

```ts
import { cryptoSignSignature, cryptoSignVerify } from "@theqrl/mldsa87";

const ctx = "ZOND/QNS/v1"; // domain separator — prevents cross-protocol replay

const sig = cryptoSignSignature(
  new Uint8Array(4627),    // signature buffer (output)
  message,                 // bytes to sign
  secretKey,               // 4,896 bytes
  true,                    // randomized signing
  ctx,
);

const ok = cryptoSignVerify(sig, message, publicKey, ctx);
```

- Signature size: **4,627 bytes**.
- Public key size: **2,592 bytes**.
- Secret key size: **4,896 bytes**.

## Size implications (breaks ENS assumptions)

ENS code paths that assume 65-byte secp256k1 signatures do not compose with ML-DSA:

- **Don't store signatures on-chain.** 4,627-byte sig × N records = gas disaster. Design records so signatures live off-chain (CCIP-Read gateway) with on-chain namehash pointers.
- **Don't embed pubkeys in call data for per-call verification unless necessary.** 2,592-byte pubkey per call is expensive. Prefer pubkey-by-reference (`bytes32 pubkeyHash` → off-chain fetch) when size matters.
- **Do publish pubkeys as resolver records** (the `pubkey` profile — Phase 4 QNS extension) — persistent storage with a namehash key, read once per session.

## On-chain verification: two paths

### Path 1: ML-DSA precompile (if available)

If `go-zond` provides an ML-DSA-87 verification precompile (analogous to `ecrecover` at `0x01`):

```solidity
(bool ok, bytes memory result) = MLDSA_PRECOMPILE.staticcall(
    abi.encode(message, signature, publicKey, ctx)
);
require(ok && result.length == 32 && uint256(bytes32(result)) == 1, "invalid sig");
```

Gas cost unknown — depends on implementation. Likely 100K–500K gas per verify based on precedent in EIP-7251-style verification precompiles.

**Open question** — see `OPEN-QUESTIONS.md`. If the precompile doesn't exist, lobby for inclusion before mainnet.

### Path 2: In-EVM verifier (fallback)

Implement `ML_DSA_87.verify()` as a Solidity library. Estimated gas: **5–10M** per verify. Acceptable for infrequent operations (setting primary reverse name once per user), painful for high-frequency use (per-request CCIP-Read response verification).

Do not write this in-EVM verifier in the initial Phase 4 pass — it is a significant undertaking with subtle attack surface (timing, malleability, NIST-compliant rejection sampling in fixed gas). Either get a precompile or defer signed records entirely.

## Concrete mappings

| ENS flow | QNS replacement |
|---|---|
| `setNameForAddrWithSignature(address, string name, uint256 expiry, bytes signature)` where signature is EIP-712 over the tuple | Same function shape. Signature is 4,627 bytes ML-DSA-87 over the keccak256 of the tuple encoded with context `"ZOND/QNS/v1"`. Verifier is the precompile path. |
| EIP-5559 off-chain write: `StorageHandledByOffChainDatabase(url, message)` with client-signed message | Client signs `message` with ML-DSA-87 + ctx. Gateway persists and serves signed response. Read path verifies via precompile. |
| CCIP-Read: resolver reverts with `OffchainLookup`, client fetches from URL, resolver callback verifies response | Gateway signs response with service ML-DSA key. Resolver callback verifies via precompile. |

## Domain separation

Always use `"ZOND/QNS/v1"` (or later versioned values) as the context string to avoid cross-protocol replay. The library's default `"ZOND"` context is the chain-level separator; QNS adds a protocol-level one.

## Phase 4 delivery checklist

- [ ] Resolve ML-DSA precompile availability (OPEN-QUESTIONS #2).
- [ ] Contract: `QRLSignatureVerifier.sol` (precompile wrapper or in-EVM fallback).
- [ ] Contract: `SignatureReverseRegistrar.sol` — ENSIP-19 signature variant.
- [ ] SDK: `setName(address, name)` wrapping ML-DSA signing.
- [ ] CCIP-Read gateway service (separate repo/service).
- [ ] Pubkey resolver profile (`IPubkeyResolver.setMlDsaPubkey(bytes32, bytes)`).

## References

- `@theqrl/mldsa87`: https://github.com/theQRL/qrypto.js
- Halborn audit report: linked from qrypto.js README (2026-03-31)
- EIP-3668 (CCIP-Read): https://eips.ethereum.org/EIPS/eip-3668
- EIP-5559 (off-chain writes): https://eips.ethereum.org/EIPS/eip-5559
- ENSIP-19: https://docs.ens.domains/ensip/19
