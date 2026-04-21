# Vendored ENS Contracts

Pinned copy of [`ensdomains/ens-contracts`](https://github.com/ensdomains/ens-contracts), minimally modified for QRL Zond. Actual diffs vs upstream are tracked in `DIFFS.md`.

## Pin

```
repo:   ensdomains/ens-contracts
tag:    v1.6.2
commit: 3d477d4
date:   2025-12-08
reason: last stable tagged release pre-ENSv2; includes ENSIP-19 per-chain reverse and modern resolver profiles. Q4 2025 target per docs/PORT-PLAN.md.
```

## Currently vendored (Phase 1.1: registry layer only)

| Upstream path | Vendored location | Diff |
|---|---|---|
| `contracts/registry/ENS.sol` | `registry/ENS.sol` | none |
| `contracts/registry/ENSRegistry.sol` | `registry/ENSRegistry.sol` | 1 line (constructor visibility) |
| `contracts/root/Root.sol` | `root/Root.sol` | 3 lines (OZ v5 migration) |
| `contracts/root/Controllable.sol` | `root/Controllable.sol` | 1 line (OZ v5 migration) |

Not vendored yet (Phase 1.2+):
- `contracts/resolvers/*` (PublicResolver + profiles) — brings Path A dual-stack resolver diffs.
- `contracts/reverseRegistrar/*` — Phase 2.
- `contracts/universalResolver/*` — Phase 2.

**Permanently excluded:**
- `contracts/wrapper/*` (NameWrapper) — fuses/permissions outside post-quantum scope.
- `contracts/ethregistrar/*` (auction stack) — replaced by custom `FIFSQRLRegistrar` for MVP.
- `contracts/dnssec-oracle/*` (DNSSEC) — out of scope.
- `contracts/dnsregistrar/*` — out of scope.
- `contracts/ccipRead/*` — revisit in Phase 4 if needed.
- Upstream `contracts/root/Ownable.sol` — not used by files in this scope.

## Dependencies

Pulled via `forge install`, tracked in `lib/`:

| Package | Pin | Purpose |
|---|---|---|
| `OpenZeppelin/openzeppelin-contracts` | `v5.1.0` (SHA `69c8def5`) | `Ownable`, `Context` (for Controllable/Root) |
| `foundry-rs/forge-std` | `v1.15.0` (SHA `0844d7e`) | Test-suite scaffolding (Phase 1.2+) |

## Modification policy

- **Touch vendored files minimally.** Every diff vs upstream is documented in `DIFFS.md`.
- **Prefer composition over editing.** QRL-specific behavior (e.g., `IQRLAddrResolver` profile) lives in new files **outside** this directory and inherits/composes vendored code.
- **Preserve headers and inline comments** from upstream where possible.

## License

ENS contracts are MIT (see `LICENSE` in this directory, copied verbatim from `ensdomains/ens-contracts@v1.6.2`). MIT code composed into a GPL-3.0 project (QNS) is compatible.
