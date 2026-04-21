# Crypto Integration: ML-DSA-87 for Signed Records

Status as of 2026-04-21: Phase 4 scoped; implementation pending precompile docs drop (2026-04-28).

## Scope

**Inside the EVM** nothing changes. keccak256 is available on Hyperion/QRVM; ownership in ENS/QNS core paths (registry, resolver writes) is enforced by `msg.sender`, verified at consensus using ML-DSA-87 transaction signatures. No `ecrecover` appears in Phase 1/2/3 code paths — which is good because **`ecrecover` is removed on Zond** ("ECDSA has NO place" per QRL dev Cyyber).

**Off-chain** there are three signing surfaces inherited from ENS that Phase 4 reimplements against ML-DSA-87:

1. **ENSIP-19 signature-based reverse** (`setNameForAddrWithSignature`, selector `0x2023a04c`): user signs a message, contract verifies. Upstream uses `ecrecover`.
2. **EIP-5559 / ERC-7700 off-chain writes**: client signs record update, gateway relays.
3. **CCIP-Read (EIP-3668)**: resolver reverts with `OffchainLookup`, client fetches signed gateway response.

All three replace `ecrecover(65-byte secp256k1)` with `ML-DSA-87 precompile(4627-byte sig, 2592-byte pk)`.

## Library (client-side)

- [`@theqrl/mldsa87`](https://www.npmjs.com/package/@theqrl/mldsa87) v1.1.1.
- Code-frozen 2026-02-13. Halborn-audited 2026-03-31 — all 13 informational findings resolved.
- Commit `58db119` + remediation commits `1661eca`, `f9fb304`, `2c4335b`, `201e2e3`.

### API shape

```ts
import { cryptoSignSignature, cryptoSignVerify } from "@theqrl/mldsa87";

const ctx = "ZOND/QNS/v1"; // domain separator — prevents cross-protocol replay

const sig = cryptoSignSignature(
  new Uint8Array(4627),   // signature buffer (output)
  message,                // bytes to sign
  secretKey,              // 4,896 bytes
  true,                   // randomized signing
  ctx,
);

const ok = cryptoSignVerify(sig, message, publicKey, ctx);
```

- Signature: **4,627 bytes**.
- Public key: **2,592 bytes**.
- Secret key: **4,896 bytes**.

## Size implications (breaks ENS assumptions)

ENS code paths that assume 65-byte secp256k1 signatures do not compose with ML-DSA:

- **Don't store signatures on-chain.** 4,627-byte sig × N records = gas disaster. Design records so signatures live off-chain (CCIP-Read gateway) with on-chain namehash pointers.
- **Don't embed pubkeys in call data per-call unless necessary.** 2,592-byte pubkey per call is expensive. Prefer pubkey-by-reference (`bytes32 pubkeyHash` + off-chain fetch) when size matters.
- **Do publish pubkeys as resolver records.** The `pubkey` profile (Phase 4 QNS extension) stores pubkeys persistently, keyed by namehash — read once per session.

## On-chain verification: precompile path (confirmed)

Cyyber confirmed 2026-04-21 that Zond ships ML-DSA-87 verification precompile(s). Docs expected 2026-04-28 will document:

- **Address**: TBD (likely a QRL-reserved slot).
- **ABI**: TBD — the two plausible shapes are `verify(msg, sig, pk, ctx) -> bool` and `verify(msg_with_ctx_hashed_in, sig, pk) -> bool`. These have different cost implications for domain separation.
- **Gas cost**: TBD. Likely in the 100K-500K range based on comparable verification precompiles (EIP-7251 style). If it lands near 100K, we can use verification liberally in resolvers; if near 1M, we restrict it to rare "set primary name" paths.
- **Return shape**: bool `0x01`/`0x00`, or "returndata matches message" pattern (like some EVM precompiles).
- **Recovery variant?** An `ml_dsa_recover(sig, msg) -> pubkey` would eliminate the 2.6KB pubkey from every signed call.
- **Batch verify?** `verify(sigs[], msgs[], pks[])` would be cheaper for multi-sig-like patterns.

(Send the follow-up questions in `/tmp/cyyber-questions.md`.)

### Call sketch (once docs land)

```solidity
address constant MLDSA_VERIFY = address(0x??); // TBD

function verifyMlDsa(bytes memory message, bytes memory signature, bytes memory publicKey)
    internal view returns (bool)
{
    (bool ok, bytes memory result) = MLDSA_VERIFY.staticcall(
        abi.encode(message, signature, publicKey) // + ctx if ABI accepts it
    );
    return ok && result.length == 32 && uint256(bytes32(result)) == 1;
}
```

## In-EVM fallback (NOT needed given precompile confirmation)

Previously we planned a `ML_DSA_87.verify()` Solidity library at ~5-10M gas per verify as a fallback. This is **no longer needed** — precompile is available. Keeping the note here because a pure-Solidity verifier would remain useful in two scenarios:

- A hypothetical QNS fork on a chain without the precompile.
- Audit comparison ("does the precompile agree with a reference in-EVM verifier for N test vectors?").

Neither is Phase 4 scope.

## Concrete mappings

| ENS flow | QNS replacement |
|---|---|
| `setNameForAddrWithSignature(address, string name, uint256 expiry, bytes signature)` where signature is EIP-712 over the tuple | Same function shape. Signature is 4,627-byte ML-DSA-87 over keccak256 of the tuple encoded with context `"ZOND/QNS/v1"`. Verifier is the precompile. |
| EIP-5559 off-chain write: `StorageHandledByOffChainDatabase(url, message)` with client-signed message | Client signs `message` with ML-DSA-87 + ctx. Gateway persists and serves signed response. Read path verifies via precompile. |
| CCIP-Read: resolver reverts with `OffchainLookup`, client fetches from URL, resolver callback verifies response | Gateway signs response with service ML-DSA key. Resolver callback verifies via precompile. |

## Domain separation

Always use `"ZOND/QNS/v1"` (or later versioned values) as the context string to avoid cross-protocol replay. The library's default `"ZOND"` context is the chain-level separator; QNS adds a protocol-level one.

**Open**: does the precompile accept `ctx` as a parameter or expect it hashed into the message pre-call? This changes how domain separation works on-chain. Part of the Cyyber follow-up.

## Phase 4 delivery checklist

- [x] Resolve ML-DSA precompile availability (Q2 answered by Cyyber 2026-04-21).
- [ ] Precompile address + ABI + gas cost documented (pending 2026-04-28).
- [ ] `QRLSignatureVerifier.sol` wrapping the precompile.
- [ ] `SignatureReverseRegistrar.sol` — ENSIP-19 signature variant.
- [ ] SDK: `setName(address, name)` wrapping ML-DSA signing with `"ZOND/QNS/v1"` context.
- [ ] CCIP-Read gateway service (separate repo; off-chain signed record storage).
- [ ] `IPubkeyResolver` profile — publish ML-DSA-87 pubkeys as name-indexed records (the post-quantum identity extension).

## References

- `@theqrl/mldsa87`: https://github.com/theQRL/qrypto.js
- Halborn audit report: linked from qrypto.js README (2026-03-31)
- EIP-3668 (CCIP-Read): https://eips.ethereum.org/EIPS/eip-3668
- EIP-5559 (off-chain writes): https://eips.ethereum.org/EIPS/eip-5559
- ENSIP-19 (per-chain reverse + signature variant): https://docs.ens.domains/ensip/19
