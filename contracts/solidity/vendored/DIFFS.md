# Vendored ENS Contracts: Diffs vs Upstream

Pin: **`ensdomains/ens-contracts` tag `v1.6.2`, commit `3d477d4`, authored 2025-12-08.**

Every deviation from upstream is recorded below with file, line range, rationale, and whether the diff is re-mergeable on a future pin bump.

---

## OZ v5 migration (affects `root/Controllable.sol`, `root/Root.sol`)

**Upstream:** ENS v1.6.2 was written against OpenZeppelin v4, which has a no-arg `Ownable` constructor. It uses `@openzeppelin/contracts/access/Ownable.sol` imported without arguments.

**QNS:** We pin OpenZeppelin v5.1.0 (submodule at `lib/openzeppelin-contracts`). OZ v5's `Ownable` requires an `initialOwner` argument. We patch the vendored files that inherit from `Ownable` to forward `msg.sender`.

### `root/Controllable.sol`

- Added `constructor() Ownable(msg.sender) {}` so OZ v5 gets a valid initial owner.
- Marker comment above the contract declaration.

### `root/Root.sol`

- Changed `contract Root is Ownable, Controllable` to `contract Root is Controllable` (Controllable already inherits Ownable; double inheritance was cosmetic).
- Removed the direct `@openzeppelin/contracts/access/Ownable.sol` import (no longer needed).
- Changed constructor from `constructor(ENS _ens) public { ens = _ens; }` to `constructor(ENS _ens) { ens = _ens; }` (removes deprecated `public` and dropped the explicit Ownable call — Controllable's constructor handles it).
- Marker comment above the contract declaration.

**Re-mergeable?** Not automatically when ENS upgrades to OZ v5; the upstream change would conflict. When the next pin bump happens, check whether ENS has migrated to OZ v5 and either drop these diffs or re-apply the same pattern.

---

## Solidity 0.7+ constructor visibility cleanup (`registry/ENSRegistry.sol`)

**Upstream:** `constructor() public { ... }` on line 24 of `ENSRegistry.sol`. Constructor `public` keyword is deprecated since Solidity 0.7.

**QNS:** Removed `public` (Solidity 0.8.24 emits a warning for it; we want clean builds).

**Re-mergeable?** Yes trivially. Upstream will likely drop this eventually.

---

## What is NOT patched (intentionally left as upstream)

- **Lint warnings from `forge build`** about unaliased plain imports, unwrapped modifier logic, and `keccak256(abi.encodePacked(...))` vs inline assembly. These are style suggestions, not correctness issues. Leaving upstream as-is keeps diffs minimal.
- **`require(...)` statements without error messages** (old ENS style). Fine; not worth a diff.

---

## Path A (dual-stack resolver) address-representation diffs

**Status:** Not yet applied. The `address`/`bytes` diffs for Path A land when we vendor the `resolvers/` tree in Phase 1.2. This file will be extended then.

---

## Files vendored in this scope

- `registry/ENS.sol` — unchanged
- `registry/ENSRegistry.sol` — 1-line diff (constructor visibility)
- `root/Root.sol` — 3-line diff (constructor, inheritance)
- `root/Controllable.sol` — 1-line diff (constructor)

Total vendored diff: ~6 lines across 3 files. The `root/Ownable.sol` file from upstream is NOT vendored (not used by any file in this scope).
