# Vendored contract differences

Upstream pin: `ensdomains/ens-contracts` v1.6.2 at commit `3d477d4`, dated 2025-12-08.

## Hyperion conversion

The selected Solidity sources were converted to `.hyp` files and their imports were rewritten to relative Hyperion paths. Hyperion is the canonical source language in this repository. There is no generated Solidity mirror.

## Ownership compatibility

The in-tree `openzeppelin/access/Ownable.hyp` follows the OpenZeppelin v5 constructor shape and takes an initial owner.

- `root/Controllable.hyp` calls `Ownable(msg.sender)`.
- `root/Root.hyp` inherits `Controllable` once and removes redundant direct `Ownable` inheritance.
- `reverseRegistrar/ReverseRegistrar.hyp` inherits `Controllable` once. Its `Ownable(addr).owner()` interface check remains.

## Registry constructor

`registry/ENSRegistry.hyp` omits the deprecated `public` constructor visibility used by the upstream Solidity source.

## QRL 2.0 reverse labels

`reverseRegistrar/ReverseRegistrar.hyp` serializes all 64 bytes of a native QRL 2.0 address as 128 lowercase hexadecimal ASCII characters before applying Keccak-256. The upstream ENS implementation serializes 20-byte addresses as 40 characters.

The encoder uses fixed-byte indexing instead of the upstream inline assembly. Hyperion's QRVM word is 64 bytes, so the upstream `byte()` lookup table alignment is not valid for this target. This is a consensus-visible QNS change and must stay synchronized with `sdk/src/resolver.ts`.

## OpenZeppelin subset

The three files under `openzeppelin/` are small in-tree implementations of the Ownable and ERC-165 interfaces required by QNS. They avoid compiler remapping and submodule dependencies. They are MIT-licensed.

## Identifier rename (2026-08-25)

Review feedback: the ported registry still identified itself as ENS. The upstream identifiers were renamed so the code reads as QNS while the MIT notices, the upstream pin and this log keep the provenance:

- `registry/ENS.hyp` `interface ENS` is now `registry/IQNSRegistry.hyp` `interface IQNSRegistry`.
- `registry/ENSRegistry.hyp` `contract ENSRegistry` is now `registry/QNSRegistry.hyp` `contract QNSRegistry`.
- The registry references in `root/Root.hyp`, `reverseRegistrar/ReverseRegistrar.hyp`, `registry/FIFSQRLRegistrar.hyp` and `resolvers/QRLPublicResolver.hyp` are typed `IQNSRegistry` and named `qns` (constructor parameters `_qns` / `qnsAddr`), so the public getter is `qns()` instead of `ens()`.
- Docstrings say "QNS registry"; ENSIP references stay because they name the standards being followed.

Events, function selectors, storage layout and bytecode logic are unchanged; only contract names, the getter name and artifact file names differ. Deployment records use the `QNSRegistry` key; `scripts/register-and-resolve.js` still reads the older `ENSRegistry` key from existing records.
