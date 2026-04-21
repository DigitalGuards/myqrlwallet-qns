# Address Compatibility: Path A (Dual-Stack Resolver)

Status as of 2026-04-21: **implemented and live on Testnet V2**.

## Problem

ENS assumes a 20-byte Solidity `address`. QRL Zond wallet-displayed addresses are **24 bytes** (with a 3-byte descriptor). Three candidate friction points:

1. `IAddrResolver.addr(bytes32) returns (address)` returns a 20-byte `address` type.
2. Solidity language: `address` is exactly 20 bytes.
3. `ReverseRegistrar.sha3HexAddress` hashes a **40-char** lowercase hex of an `address` - hard-coded length.

## Q1 finding (resolved): Hyperion preserves 20-byte `address`

Verified 2026-04-21 in `/home/waterfall/myqrlwallet/hyperion/libhyperion/ast/Types.h:455-456`:

```cpp
unsigned calldataEncodedSize(bool _padded = true) const override { return _padded ? 32 : 160 / 8; }
unsigned storageBytes() const override { return 160 / 8; }
```

`160/8 = 20`. Storage and unpadded calldata match Ethereum. **The Solidity `address` type is unchanged.** The 24-byte wallet-displayed form is a presentation-layer concept, not an EVM type.

This collapses friction points 2 and 3: `msg.sender` is 20 bytes; `sha3HexAddress(20-byte)` works unchanged.

## Decision: Path A — Dual-Stack Resolver

QNS keeps both address views side by side:

### Primary (QRL-native): `qrlAddr(bytes32) returns (bytes)`

New resolver profile `IQRLAddrResolver` (`contracts/solidity/resolvers/profiles/IQRLAddrResolver.sol`):

```solidity
interface IQRLAddrResolver {
    event QrlAddrChanged(bytes32 indexed node, bytes qrlAddress);
    function qrlAddr(bytes32 node) external view returns (bytes memory);
}
```

- Stores the full 24-byte wallet-display form as `bytes`.
- Setter enforces `qrlAddress.length == 0 || qrlAddress.length == 24`.
- Emits `QrlAddrChanged` on writes.

### Compatibility: legacy `addr(bytes32) returns (address)`

- Returns the 20-byte EVM `address` (exactly what `msg.sender` resolves to on-chain).
- Standard `IAddrResolver` from ENS, unchanged.
- Not a "lossy shim" (initial misconception pre-Q1): it's the genuine EVM-level address. The wallet-display 24-byte form is a *different* representation, not a superset — how they map to each other is still open (see OPEN-QUESTIONS Q4).

### Multichain (Phase 3): ENSIP-9 `addr(bytes32, uint256)`

Use the standard ENSIP-9/EIP-2304 multichain resolver with a QRL Zond coinType derived per ENSIP-11:

```
coinType = 0x80000000 | chainId
```

- Testnet V2 (chainId `1337`): `0x80000539`.
- Mainnet: TBD (gated on mainnet chainId commitment).

This makes QNS names resolvable by any ENS-aware client that supports the standard multichain resolver.

### Reverse namespace: **standard ENSIP-19** (no `sha3QRLAddress`)

Earlier drafts proposed a `sha3QRLAddress(24-byte)` variant. Post-Q1 this is unnecessary: ENSIP-19's `sha3HexAddress(20-byte)` works out of the box because Hyperion's `address` is 20 bytes. QNS uses the upstream implementation unchanged.

## Rejected alternatives

### Path B: Hyperion redefines `address` to 24 bytes

**Did not happen.** Q1 confirmed Hyperion preserves the 20-byte type. Had this been the case, QNS would have needed to fork ENS more aggressively (retype every `address` field, shift selectors, give up OZ reuse). Path A was the correct bet.

### Path C: Strip descriptor, store 20 bytes only

**Rejected.** The wallet-display 24-byte form carries information that the ecosystem may need (routing, display). Storing only 20 bytes means callers can't reconstruct the display form without out-of-band data. Path A keeps both views cheap.

## Implementation checklist — DONE

- [x] `IQRLAddrResolver.sol` profile.
- [x] `QRLPublicResolver.sol` composes the profile alongside `IAddrResolver`, `ITextResolver`, `IContentHashResolver`, `INameResolver` (Phase 2).
- [x] Length validation on `setQrlAddr` (empty or 24 bytes).
- [x] 15 forward-resolution tests in `contracts/test/ForwardResolution.t.sol`.
- [x] Live on testnet; `alice.qrl` has a 24-byte `qrlAddr` resolvable via SDK `resolveName()`.
- [x] coinType `0x80000539` recorded in `config/testnet.json`.
- [ ] `IAddressResolver` multichain extension on `QRLPublicResolver` — Phase 3.

## Still open

**Q4**: how does the 24-byte wallet-display form relate to the 20-byte EVM `msg.sender`? A user who scans a 24-byte QR-style display address and wants to know "who is this?" on-chain needs a deterministic mapping from 24-byte display to 20-byte EVM address. This is not currently documented in go-qrl / wallet.js and is a pending Cyyber question (see `OPEN-QUESTIONS.md` Q4).

## References

- EIP-137 (ENS): namehash + `addr(bytes32)`
- EIP-2304 / ENSIP-9: multichain `addr(bytes32, uint256)`
- ENSIP-11: EVM coinType derivation
- ENSIP-15: normalization
- ENSIP-19: per-chain reverse namespace
- `libhyperion/ast/Types.h:455-456`: Hyperion `address` = 20 bytes
