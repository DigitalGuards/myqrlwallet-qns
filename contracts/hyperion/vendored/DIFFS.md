# Vendored contract differences

Upstream pin: `ensdomains/ens-contracts` commit `3d477d43959db296e227907a768dc0252fc4edc4`, dated 2025-12-08 (the upstream version bump titled "v1.6.2"; upstream publishes no `v1.6.2` git tag, so the commit hash is the pin).

This file records every intentional divergence from the pinned upstream sources. Anything not listed here is a bug in either the port or this log.

## Hyperion conversion (all files)

- Sources converted from Solidity to `.hyp`; imports rewritten to relative Hyperion paths. Hyperion is the canonical source language; there is no generated Solidity mirror.
- `pragma solidity >=0.8.4` replaced by `pragma hyperion >=0.0`, which drops the language-version floor. `ResolverBase.hyp` (public mapping implicitly overriding `IVersionableResolver.recordVersions`) and `ERC165.hyp` (implicit `IERC165` override) rely on the implicit-interface-override rule; revisit the floor once Hyperion adopts release versioning.
- SPDX headers added to upstream files that shipped without one (`ENSRegistry`, `ReverseRegistrar`, `Root`, `Controllable`, `IReverseRegistrar`).

## Ownership compatibility

The in-tree `openzeppelin/access/Ownable.hyp` follows the OpenZeppelin v5 shape: constructor takes an initial owner, unauthorized access reverts with the `OwnableUnauthorizedAccount` / `OwnableInvalidOwner` custom errors (upstream ENS vendored OZ v4 `require` strings), and `Context`/`_msgSender()` is dropped in favor of raw `msg.sender`.

- `root/Controllable.hyp` calls `Ownable(msg.sender)`.
- `root/Root.hyp` inherits `Controllable` once and removes redundant direct `Ownable` inheritance.
- `reverseRegistrar/ReverseRegistrar.hyp` inherits `Controllable` once. Its `Ownable(addr).owner()` interface check remains.

## Registry

`registry/ENSRegistry.hyp` omits the deprecated `public` constructor visibility. All authorization, event ordering, approval, and record semantics match upstream byte for byte.

## QRL 2.0 reverse labels

`reverseRegistrar/ReverseRegistrar.hyp` serializes all 64 bytes of a native QRL 2.0 address as 128 lowercase hexadecimal ASCII characters before applying Keccak-256. The upstream ENS implementation serializes 20-byte addresses as 40 characters.

- The upstream inline-assembly `sha3HexAddress` body and its `lookup` constant are removed; the function delegates to the QNS-authored library `contracts/hyperion/reverse/QRLAddressReverse.hyp` (fixed-byte indexing; Hyperion's QRVM word is 64 bytes, so the upstream `byte()` lookup-table alignment is not valid for this target).
- This is a consensus-visible QNS change and must stay synchronized with `sdk/src/resolver.ts`. The shared known-answer vector in `sdk/src/fixtures/qns-vectors.json` pins the encoding on both sides.

## Resolver (custom `resolvers/QRLPublicResolver.hyp`, upstream-derived semantics)

- Authorization is narrowed to strict name-owner-only writes (`resolvers/QRLResolverAuthorization.hyp`): upstream `PublicResolver`'s operator approvals (`setApprovalForAll`) and per-name delegates (`approve`) are removed, and `ENSRegistry.isApprovedForAll` is not consulted. Note the asymmetry: `ReverseRegistrar` still honors registry operator approvals for reverse claims. Whether resolver writes should honor registry operator approvals is an open design decision.
- `addr(bytes32)` returns the native 64-byte address in one 64-byte ABI word. The upstream multichain profile (`IAddressResolver`, `addr(node,coinType)`, the `AddressChanged` event, `versionable_addresses`) is omitted; `setAddr` emits `AddrChanged` only. Event-sourced indexers built on the upstream schema must key on `AddrChanged`.
- `supportsInterface` still advertises the upstream ENS interface IDs (`IAddrResolver` 0x3b3b57de and peers) although the `addr` payload is 64 bytes wide. On QRVM every ABI word is 64 bytes, so native clients are unaffected; tooling ported from 32-byte chains must not decode these replies with the Ethereum ABI. Minting QRL-specific interface IDs is an open design decision.
- `Multicallable`, `ReverseClaimer`, `ABIResolver`, `DNSResolver`, `InterfaceResolver`, and `PubkeyResolver` are out of scope.

## Registrar (custom `registry/FIFSQRLRegistrar.hyp`)

Derived from upstream `FIFSRegistrar` with additions: a `Registered` event, an `available(bytes32)` view, and a custom `NotAvailable` error in place of the upstream bare `require`.

## OpenZeppelin subset

The files under `openzeppelin/` are small in-tree implementations of the OZ v5 Ownable and ERC-165 behavior required by QNS. They avoid compiler remapping and submodule dependencies. They are MIT-licensed.

## Identifier rename (2026-08-25)

Review feedback: the ported registry still identified itself as ENS. The upstream identifiers were renamed so the code reads as QNS while the MIT notices, the upstream pin and this log keep the provenance:

- `registry/ENS.hyp` `interface ENS` is now `registry/IQNSRegistry.hyp` `interface IQNSRegistry`.
- `registry/ENSRegistry.hyp` `contract ENSRegistry` is now `registry/QNSRegistry.hyp` `contract QNSRegistry`.
- The registry references in `root/Root.hyp`, `reverseRegistrar/ReverseRegistrar.hyp`, `registry/FIFSQRLRegistrar.hyp` and `resolvers/QRLPublicResolver.hyp` are typed `IQNSRegistry` and named `qns` (constructor parameters `_qns` / `qnsAddr`). Each contract also retains an explicit `ens()` compatibility getter for ENS-derived integrations.
- Docstrings say "QNS registry"; ENSIP references stay because they name the standards being followed.

Existing operational selectors, events and storage layout are unchanged. The port adds the `qns()` getter and retains `ens()` as an alias. Contract names, metadata and artifact file names use QNS identifiers. New deployment records use the `QNSRegistry` key.
