# Address Compatibility: Path A (Dual-Stack Resolver)

## Problem

ENS assumes a 20-byte Solidity `address`. QRL Zond addresses are **24 bytes** with a **separated 3-byte cryptographic descriptor** (post-April-2025 go-qrllib refactor). Three ENS assumptions conflict:

1. `IAddrResolver.addr(bytes32) returns (address)` — returns 20-byte `address`.
2. Solidity language: `address` type is exactly 20 bytes in a 32-byte EVM word.
3. `ReverseRegistrar.sha3HexAddress` hashes a **40-char** lowercase hex string of an address — hard-coded length.

## Decision: Path A — Dual-Stack Resolver

QNS stores the **native 24-byte QRL address as bytes** and exposes two resolver views:

### Primary: `qrlAddr(bytes32) returns (bytes)`

New resolver profile `IQRLAddrResolver`:

```solidity
interface IQRLAddrResolver {
    event QrlAddrChanged(bytes32 indexed node, bytes qrlAddress);
    function qrlAddr(bytes32 node) external view returns (bytes memory);
    function setQrlAddr(bytes32 node, bytes calldata qrlAddress) external;
}
```

- `bytes` return type: the full 24-byte native QRL address.
- The 3-byte descriptor can be fetched separately from Zond's account metadata — QNS does not duplicate it.
- `bytes` length is checked in the setter (`require(qrlAddress.length == 24)`).

### Compatibility shim: `addr(bytes32) returns (address)`

Retain the legacy `IAddrResolver.addr()` for tooling compatibility:

- Returns the **last 20 bytes** of the stored 24-byte address cast to `address`.
- Emits `AddrChanged` alongside `QrlAddrChanged` on writes.
- Documented as **lossy** — consumers needing the full 24-byte address must call `qrlAddr()`.

### Multichain: ENSIP-9 `addr(bytes32, uint256 coinType) returns (bytes)`

Use the standard ENSIP-9/EIP-2304 multichain resolver with a **QRL Zond coinType** derived per ENSIP-11:

```
coinType = 0x80000000 | chainId
```

With testnet chainId `1337`, the testnet coinType is `0x80000539`. Register the mainnet chainId with SLIP-44 / the ENS coin registry during Phase 5 mainnet prep.

This makes QNS names resolvable by any ENS-aware client that supports the standard multichain resolver — `resolveName("alice.qrl", { coinType: 0x80000539 })` works in stock ensjs.

### Reverse namespace: `sha3QRLAddress`

ENS's `sha3HexAddress(addr)` is `keccak256(lowercase_hex(addr, 40 chars))`. QNS uses:

```
sha3QRLAddress(qrlAddress) = keccak256(lowercase_hex(qrlAddress, 48 chars))
```

- Input: 24-byte native address (no `Q` prefix, no `0x`, no descriptor).
- Output: 32-byte node hash plugged into the per-chain reverse namespace: `<sha3QRLAddress>.<coinTypeHex>.reverse`.
- Per ENSIP-19 second form, this keeps reverse lookups forward-compatible with ENS clients that speak UniversalResolver across chains.

## Rejected alternatives

### Path B: Hyperion redefines `address` to 24 bytes

**Rejected because:** would break ENS compile-unmodified assumption. Every `address` field in the registry would need retyping, function selectors would shift, and the broader Solidity ecosystem (OpenZeppelin, etc.) would not be reusable. This is a project-level risk we cannot mitigate at the QNS layer.

**If Hyperion does this anyway** (open question — see `OPEN-QUESTIONS.md`), QNS would need to fork ENS more aggressively and become a different project architecturally. Path A is the bet that Hyperion preserves the 20-byte `address` type.

### Path C: Strip descriptor, store 20 bytes only

**Rejected because:** the 20-byte tail may not be collision-resistant on its own — the descriptor carries signature-scheme information that the ecosystem may require for routing/display. Strip-then-restore is a brittle contract to maintain. Path A keeps all 24 bytes as the source of truth and derives shorter views when needed.

## Implementation checklist (Phase 1)

- [ ] Add `IQRLAddrResolver.sol` profile.
- [ ] Extend `PublicResolver` (vendored) to inherit the new profile with minimal edit — store `bytes` keyed by node.
- [ ] Implement `addr(bytes32)` shim in a new file that calls `qrlAddr()` and truncates.
- [ ] Replace `sha3HexAddress` in `ReverseRegistrar` — document the diff in `contracts/solidity/vendored/DIFFS.md`.
- [ ] Unit-test round-trip: set `qrlAddr`, read back, verify legacy `addr()` returns the last 20 bytes.
- [ ] Document the coinType value in `config/testnet.json`.

## References

- EIP-137 (ENS) — namehash + `addr(bytes32)`
- EIP-2304 / ENSIP-9 — multichain `addr(bytes32, uint256)`
- ENSIP-11 — EVM coinType derivation
- ENSIP-15 — normalization
- ENSIP-19 — per-chain reverse namespace
