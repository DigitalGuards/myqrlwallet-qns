# Vendored ENS Contracts

Pinned copy of [`ensdomains/ens-contracts`](https://github.com/ensdomains/ens-contracts) plus a minimal in-tree OpenZeppelin subset, modified for QRL Zond. Diffs vs upstream are tracked in `DIFFS.md`.

## Pin

```
repo:   ensdomains/ens-contracts
tag:    v1.6.2
commit: 3d477d4
date:   2025-12-08
reason: last stable tagged release pre-ENSv2; includes ENSIP-19 per-chain reverse and modern resolver profiles.
```

## Vendored files (Phase 2 complete)

### Registry layer (Phase 1)

| Upstream path | Vendored location | Diff |
|---|---|---|
| `contracts/registry/ENS.sol` | `registry/ENS.sol` | none |
| `contracts/registry/ENSRegistry.sol` | `registry/ENSRegistry.sol` | 1 line (constructor visibility) |
| `contracts/root/Root.sol` | `root/Root.sol` | 3 lines (OZ v5 migration) |
| `contracts/root/Controllable.sol` | `root/Controllable.sol` | 1 line (OZ v5 migration) |

### Resolver interfaces (Phase 1.2)

| Upstream path | Vendored location | Diff |
|---|---|---|
| `contracts/resolvers/ResolverBase.sol` | `resolvers/ResolverBase.sol` | none |
| `contracts/resolvers/profiles/IAddrResolver.sol` | `resolvers/profiles/IAddrResolver.sol` | none |
| `contracts/resolvers/profiles/ITextResolver.sol` | `resolvers/profiles/ITextResolver.sol` | none |
| `contracts/resolvers/profiles/IContentHashResolver.sol` | `resolvers/profiles/IContentHashResolver.sol` | none |
| `contracts/resolvers/profiles/IVersionableResolver.sol` | `resolvers/profiles/IVersionableResolver.sol` | none |
| `contracts/resolvers/profiles/INameResolver.sol` | `resolvers/profiles/INameResolver.sol` | none |

(The full `PublicResolver.sol` is **not** vendored; we wrote a leaner custom `QRLPublicResolver.sol` outside `vendored/` that composes the profile interfaces + our `IQRLAddrResolver` extension.)

### Reverse registrar (Phase 2)

| Upstream path | Vendored location | Diff |
|---|---|---|
| `contracts/reverseRegistrar/ReverseRegistrar.sol` | `reverseRegistrar/ReverseRegistrar.sol` | 2 lines (drop duplicate Ownable inheritance) |
| `contracts/reverseRegistrar/IReverseRegistrar.sol` | `reverseRegistrar/IReverseRegistrar.sol` | none |

### OpenZeppelin (in-tree replacement, minimal subset)

To keep Hyperion syncs portable without a git submodule, these are the **only** OZ files we use, re-implemented in-tree:

| File | Purpose |
|---|---|
| `openzeppelin/access/Ownable.sol` | OZ-v5-shaped `Ownable(initialOwner)` — inherited by `Controllable` |
| `openzeppelin/utils/introspection/IERC165.sol` | Standard ERC-165 interface |
| `openzeppelin/utils/introspection/ERC165.sol` | Minimal ERC-165 base, inherited by `ResolverBase` |

These are fresh in-tree implementations (not copied from OZ), matching the OZ v5 API we use. Apache-2.0 compatible with OZ's own license; our copies are MIT.

## Not vendored (permanent exclusions)

- `contracts/wrapper/*` (NameWrapper): fuses/permissions — outside post-quantum scope.
- `contracts/ethregistrar/*` (auction stack): replaced by custom `FIFSQRLRegistrar` for MVP.
- `contracts/dnssec-oracle/*` (DNSSEC): out of scope.
- `contracts/dnsregistrar/*`: out of scope.
- `contracts/universalResolver/*`: deferred (nice-to-have for batch reads; single-tx resolution works via direct calls).
- `contracts/ccipRead/*`: revisit in Phase 4 if off-chain signed records need it.
- `contracts/resolvers/PublicResolver.sol`: replaced by custom `QRLPublicResolver.sol` (smaller, no DNSResolver / NameWrapper deps).
- Upstream `contracts/root/Ownable.sol`: unused; Controllable inherits from OZ's `Ownable` instead.

## Dependencies

Pulled via `forge install`, tracked in `lib/`:

| Package | Pin | Purpose |
|---|---|---|
| `foundry-rs/forge-std` | `v1.15.0` (SHA `0844d7e`) | Foundry test suite |
| `OpenZeppelin/openzeppelin-contracts` | `v5.1.0` (SHA `69c8def5`) | **unused** after the in-tree OZ migration; retained in `.gitmodules` for history and possible future reuse |

## Modification policy

- **Touch vendored files minimally.** Every diff vs upstream is documented in `DIFFS.md` with file, line range, rationale, and re-mergeability note.
- **Prefer composition over editing.** QRL-specific behavior (`IQRLAddrResolver` profile, `FIFSQRLRegistrar`, `QRLPublicResolver`) lives in new files **outside** this directory and inherits/composes vendored code.
- **Preserve headers and inline comments** from upstream where possible.

## License

ENS contracts are MIT (see `LICENSE` in this directory, copied verbatim from `ensdomains/ens-contracts@v1.6.2`). In-tree OpenZeppelin replacements are MIT. MIT code composed into a GPL-3.0 project (QNS) is compatible.
