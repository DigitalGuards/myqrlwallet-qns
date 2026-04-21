# Vendored ENS Contracts: Diffs vs Upstream

Pin: **`ensdomains/ens-contracts` tag `v1.6.2`, commit `3d477d4`, authored 2025-12-08.**

Every deviation from upstream is recorded below with file, rationale, and re-mergeability. Current total: ~8 lines of diff across 4 files.

---

## OZ v5 migration (`root/Controllable.sol`, `root/Root.sol`, `reverseRegistrar/ReverseRegistrar.sol`)

**Upstream:** ENS v1.6.2 was written against OpenZeppelin v4, which has a no-arg `Ownable` constructor. It uses `@openzeppelin/contracts/access/Ownable.sol` imported without arguments.

**QNS:** We use an in-tree minimal OZ v5-compatible `Ownable` at `vendored/openzeppelin/access/Ownable.sol`. OZ v5's `Ownable` requires an `initialOwner` argument. We patch vendored files that inherit from `Ownable` to forward `msg.sender`, or to drop redundant direct inheritance when a parent already carries it.

### `root/Controllable.sol`

- Added `constructor() Ownable(msg.sender) {}` so OZ v5 gets a valid initial owner.
- Marker comment above the contract declaration.

### `root/Root.sol`

- Changed `contract Root is Ownable, Controllable` to `contract Root is Controllable` (Controllable already inherits `Ownable`; double inheritance tripped OZ v5's constructor-arg requirement).
- Removed the direct `@openzeppelin/contracts/access/Ownable.sol` import (no longer needed).
- Changed constructor from `constructor(ENS _ens) public { ens = _ens; }` to `constructor(ENS _ens) { ens = _ens; }` (drops deprecated `public`, drops explicit Ownable call since Controllable's constructor handles it).
- Marker comment above the contract declaration.

### `reverseRegistrar/ReverseRegistrar.sol`

- Changed `contract ReverseRegistrar is Ownable, Controllable, IReverseRegistrar` to `contract ReverseRegistrar is Controllable, IReverseRegistrar` (same pattern as Root: Controllable carries Ownable).
- Marker comment above the contract declaration.
- `import "@openzeppelin/contracts/access/Ownable.sol"` is **retained** because line 167 (`ownsContract`) uses `Ownable(addr).owner()` to detect if a contract implements the Ownable interface — this is a type reference, not an inheritance.

**Re-mergeable?** Not automatically when ENS upgrades to OZ v5. Upstream would produce its own pattern. On the next pin bump, check whether ENS has migrated and either drop these diffs or re-apply.

---

## Solidity 0.7+ constructor visibility cleanup (`registry/ENSRegistry.sol`)

**Upstream:** `constructor() public { ... }` on line 24. Constructor `public` keyword is deprecated since Solidity 0.7.

**QNS:** Removed `public`. Solidity 0.8.24 emits a warning for it; we want clean builds.

**Re-mergeable?** Yes trivially. Upstream will likely drop this eventually.

---

## What is NOT patched (intentionally left as upstream)

- **`forge build` lint warnings** about unaliased plain imports, unwrapped modifier logic, and `keccak256(abi.encodePacked(...))` vs inline assembly. These are style suggestions, not correctness issues. Leaving upstream as-is keeps diffs minimal.
- **`require(...)` without error messages** (old ENS style). Fine; not worth a diff.

---

## In-tree OpenZeppelin replacements

**Not diffs against ens-contracts** — these replace a git-submodule dependency on `OpenZeppelin/openzeppelin-contracts`:

- `vendored/openzeppelin/access/Ownable.sol`: minimal OZ v5-shaped `Ownable`. No `Context` dep.
- `vendored/openzeppelin/utils/introspection/IERC165.sol`: standard ERC-165 interface.
- `vendored/openzeppelin/utils/introspection/ERC165.sol`: minimal base implementing `supportsInterface(IERC165)`.

These are fresh implementations matching the OZ v5 API we actually use (constructor, `onlyOwner`, `owner()`, `transferOwnership`, `renounceOwnership`, `supportsInterface`). MIT-licensed (compatible with OZ's MIT).

**Why in-tree instead of submodule?** Hyperion (`hypc`) doesn't play well with git-submodule paths crossed with remappings — we hit "file not found" on absolute-path remappings during the Hyperion build. Keeping OZ in-tree means the sync script rewrites imports to relative `.hyp` paths cleanly.

---

## Path A (dual-stack resolver) address diffs

**Status:** implemented in custom contracts, not vendored.

- `contracts/solidity/resolvers/profiles/IQRLAddrResolver.sol`: new profile, `qrlAddr(bytes32) returns (bytes)` with 24-byte enforcement.
- `contracts/solidity/resolvers/QRLPublicResolver.sol`: custom resolver composing vendored profile interfaces (`IAddrResolver`, `ITextResolver`, `IContentHashResolver`, `INameResolver`) plus `IQRLAddrResolver`.

No diffs in `vendored/` for Path A: we prefer composition over editing upstream code.

---

## Files vendored in this scope

- `registry/ENS.sol`: unchanged
- `registry/ENSRegistry.sol`: 1-line diff (constructor visibility)
- `root/Root.sol`: 3-line diff (inheritance, constructor)
- `root/Controllable.sol`: 1-line diff (constructor)
- `resolvers/ResolverBase.sol`: unchanged
- `resolvers/profiles/IAddrResolver.sol`: unchanged
- `resolvers/profiles/ITextResolver.sol`: unchanged
- `resolvers/profiles/IContentHashResolver.sol`: unchanged
- `resolvers/profiles/IVersionableResolver.sol`: unchanged
- `resolvers/profiles/INameResolver.sol`: unchanged
- `reverseRegistrar/ReverseRegistrar.sol`: 2-line diff (Ownable inheritance)
- `reverseRegistrar/IReverseRegistrar.sol`: unchanged

Total: ~8 lines of diff across 4 files, all documented above.
