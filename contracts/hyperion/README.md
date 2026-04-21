# Hyperion Mirror

Auto-synced `.hyp` mirrors of `contracts/solidity/` for compilation with Hyperion's `hypc`. **Hyperion is the canonical deployment path** per QRL team recommendation (mainnet target). Solidity remains the source of truth; these files are generated — do not edit by hand.

## Status (2026-04-21)

- 18 `.hyp` files tracked (registry, root, resolvers, reverseRegistrar, in-tree OpenZeppelin subset, plus our custom contracts).
- `build/hyperion/*.{abi,bin}` + `manifest.json` compile cleanly via `hypc` 0.2.0-develop.2026.4.13.
- All Phase 1 + Phase 2 contracts (ENSRegistry, Root, FIFSQRLRegistrar, ReverseRegistrar, QRLPublicResolver) are **live on Testnet V2** deployed from Hyperion artifacts.

## Workflow

```bash
# Regenerate .hyp mirrors from contracts/solidity/
npm run sync:hyperion          # or: node scripts/sync-hyperion.js

# Compile + emit ABI/bin/manifest to build/hyperion/
npm run compile:hyperion       # or: node scripts/compile-hyperion.js

# Deploy via Hyperion artifacts (default)
npm run deploy:testnet

# Deploy via Foundry (solc) artifacts instead
npm run deploy:testnet:foundry
```

## Dialect translation rules

`scripts/sync-hyperion.js` walks `contracts/solidity/` preserving nested directory structure and applies these translations:

1. **Pragma**: `pragma solidity X;` → `pragma hyperion >=0.0;`
2. **Unit suffixes**: `ether` → `quanta`, `gwei` → `shor`, `wei` → `planck`
3. **Address literals**: `0x<40hex>` → `Q<40hex>` for the `address` type (exactly 40 hex matched to avoid touching `bytes32` / numeric literals).
4. **Remapped imports**: `@openzeppelin/contracts/...` and `@ensdomains/...` are rewritten to relative `.hyp` paths so `hypc` resolves them cleanly from `--base-path=contracts/hyperion`.
5. **Extensions**: `.sol` → `.hyp` on every import.

If `hypc` rejects a new pattern, extend `scripts/sync-hyperion.js` rather than hand-editing `.hyp` files.

## Deployable contracts (from `scripts/compile-hyperion.js`)

The `DEPLOYABLE` list hard-codes which top-level contracts to compile (others are interfaces / abstract and flow in as transitive imports):

```js
const DEPLOYABLE = [
    "vendored/registry/ENSRegistry.hyp",
    "vendored/root/Root.hyp",
    "vendored/reverseRegistrar/ReverseRegistrar.hyp",
    "registry/FIFSQRLRegistrar.hyp",
    "resolvers/QRLPublicResolver.hyp",
];
```

Adding a new deployable: append to this list, re-run compile.

## Build environment

- `hypc` binary at `/usr/local/bin/hypc`. Set `HYPERION_COMPILER=/path/to/hypc` if installed elsewhere.
- Rebuild from `/home/waterfall/myqrlwallet/hyperion` if missing. See `../../../QuantaPool/CLAUDE.md` for build flags (Z3/CVC4 off).
- `build/hyperion/` output is gitignored; `.hyp` sources are committed.

## Known warnings (safe to ignore)

- "This is a pre-release compiler version": `hypc` 0.2.0-develop is still pre-1.0; no production stability concerns for testnet.
- "SPDX license identifier not provided": emitted for `.hyp` mirrors because the banner comment precedes the SPDX line after sync. Not a real issue.
- "This declaration shadows an existing declaration" in `ENSRegistry.hyp` line 18 and 141: upstream ENS style, inherited. Not patched to keep diffs minimal.

## Related

- `scripts/sync-hyperion.js` — sync driver
- `scripts/compile-hyperion.js` — compile driver
- `../../../QuantaPool/scripts/sync-hyperion.js` — reference implementation (flat-layout variant)
- `../solidity/vendored/DIFFS.md` — records Solidity-source patches that flow through sync
