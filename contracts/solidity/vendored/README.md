# Vendored ENS Contracts

This directory holds a **pinned copy** of [`ensdomains/ens-contracts`](https://github.com/ensdomains/ens-contracts), minimally modified for QRL Zond. It is intentionally empty at alpha — Phase 1 copies the relevant subset in.

## What gets vendored (Phase 1)

From the pinned upstream commit:

| Upstream path | Vendored location | Purpose |
|---|---|---|
| `contracts/registry/ENS.sol` | `registry/ENS.sol` | Registry interface |
| `contracts/registry/ENSRegistry.sol` | `registry/ENSRegistry.sol` | Core registry |
| `contracts/root/Root.sol` | `registry/Root.sol` | TLD-ownership root |
| `contracts/resolvers/PublicResolver.sol` | `resolvers/PublicResolver.sol` | Default resolver |
| `contracts/resolvers/profiles/*` | `resolvers/profiles/` | Resolver record interfaces (text, addr, contenthash, etc.) |
| `contracts/reverseRegistrar/ReverseRegistrar.sol` | `reverseRegistrar/ReverseRegistrar.sol` | Reverse namespace controller |
| `contracts/reverseRegistrar/ReverseClaimer.sol` | `reverseRegistrar/ReverseClaimer.sol` | Helper mixin |
| `contracts/utils/UniversalResolver.sol` | `utils/UniversalResolver.sol` | Single-RPC resolver |

**Excluded from initial vendoring:**

- `contracts/wrapper/*` — NameWrapper, fuses, permissions. Defer indefinitely.
- `contracts/ethregistrar/*` — Auction + BaseRegistrarImplementation. Replaced by custom `FIFSQRLRegistrar` for MVP, commit/reveal for mainnet (Phase 5).
- `contracts/dnssec-oracle/*` — DNSSEC tooling. Out of scope.

## Pin

**Target commit**: TBD — select a Q4 2025 commit that is post-ENSIP-19 and pre-ENSv2 per-name-registry work.

When pinning, record here:

```
commit: <SHA>
tag:    <e.g. v1.x.y if tagged>
date:   <author date>
reason: last stable pre-ENSv2 commit; includes ENSIP-19 per-chain reverse
```

## Modification policy

Touch vendored files **minimally**. Every deviation from upstream must be recorded in `DIFFS.md` (created in Phase 1) with:

1. File path and upstream line range.
2. What changed and why (e.g., "replaced `address` with `bytes` for QRL 24-byte compat per Path A").
3. Whether it is re-mergeable on a future pin bump.

Prefer implementing QRL-specific behavior in **new files outside this directory** (e.g., `contracts/solidity/resolvers/profiles/IQRLAddrResolver.sol`) and composing rather than editing vendored Solidity.

## License

ENS contracts are [MIT-licensed](https://github.com/ensdomains/ens-contracts/blob/master/LICENSE). When vendoring, preserve the upstream `LICENSE` file alongside copied sources. QNS itself is GPL-3.0; MIT code composed into a GPL-3.0 project is compatible.

## References

- Upstream: https://github.com/ensdomains/ens-contracts
- ENS docs: https://docs.ens.domains
- ENSIP index: https://docs.ens.domains/ensip
- Port plan: [`../../docs/PORT-PLAN.md`](../../docs/PORT-PLAN.md) (actually `../../../docs/PORT-PLAN.md` from here)
