# @qns/sdk

TypeScript client SDK for the QRL Name Service. Forward/reverse resolution against a QNS registry deployed on QRL Zond.

> **Status: alpha stubs.** Only `namehash()` is implemented. `resolveName()` / `lookupAddress()` throw until Phase 1/2 contracts land — see [`../docs/ROADMAP.md`](../docs/ROADMAP.md).

## Install

```bash
npm install @qns/sdk
```

Peer deps (optional, wire up only if you need them):

```bash
npm install @theqrl/qrl_providers @theqrl/mldsa87
```

## Usage

```ts
import { namehash, nodeToHex, resolveName } from "@qns/sdk";

// Phase 0 (today): namehash is real
const node = namehash("alice.qrl");
console.log(nodeToHex(node));

// Phase 1: resolveName becomes real once contracts are deployed
// const addr = await resolveName("alice.qrl", { registry: "0x...", provider: window.qrl });
```

## What's implemented

| API | Status |
|---|---|
| `namehash(name) -> Uint8Array` | Working (keccak256 via `@noble/hashes`) |
| `nodeToHex(node) -> 0x...` | Working |
| `resolveName(name, config)` | Throws — Phase 1 |
| `lookupAddress(addr, config)` | Throws — Phase 2 |

## Normalization

This SDK assumes labels are **already normalized** per [ENSIP-15](https://docs.ens.domains/ensip/15). Use [`@adraffy/ens-normalize`](https://github.com/adraffy/ens-normalize.js) on untrusted input *before* calling `namehash`.

## Development

```bash
npm install
npm run build
npm test
```

## License

GPL-3.0 — see `../LICENSE`.
