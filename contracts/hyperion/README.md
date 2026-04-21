# Hyperion Mirror

Auto-synced `.hyp` mirrors of `contracts/solidity/` for compilation with Hyperion's `hypc`. The canonical source of truth is Solidity — these files are generated; do not edit by hand.

## Dialect translation rules

Following the pattern established in `../../../QuantaPool/scripts/sync-hyperion.js`, the sync script translates three Solidity↔Hyperion dialect differences when generating `.hyp` mirrors:

1. **Pragma** — `pragma solidity X;` → `pragma hyperion >=0.0;`
2. **Unit suffixes** — `ether` → `quanta`, `wei` → `planck`, `gwei` → `shor`
3. **Address literals** — `0x<40hex>` → `Q<40hex>` for the `address` type

If `hypc` rejects on a new pattern introduced by vendored ENS code, extend the sync script rather than hand-editing `.hyp` files.

## Workflow (Phase 1+)

```bash
node scripts/sync-hyperion.js    # Regenerates .hyp mirrors from contracts/solidity/
node scripts/compile-hyperion.js # hypc compile → build/hyperion/*.{abi,bin,manifest.json}
```

Build output lands under `build/hyperion/` (gitignored). The `hypc` binary is expected at `/usr/local/bin/hypc`; rebuild from `../../../hyperion` if missing (see `../../../QuantaPool/CLAUDE.md` for build flags — Z3/CVC4 off).

## Status

**Empty at alpha.** Sync + compile scripts + mirrored sources land with Phase 1.
