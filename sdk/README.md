# @qns/sdk

TypeScript client SDK for the QRL Name Service. Forward/reverse resolution against a QNS registry deployed on QRL Zond.

> **Status:** forward + reverse resolution live on Testnet V2 (chainId 1337) via Hyperion-compiled contracts. See the repo root [config/testnet.json](../config/testnet.json) for addresses.

## Install

```bash
npm install @qns/sdk
```

### Provider

`@qns/sdk` is provider-agnostic: anything that speaks EIP-1193 (`request({method, params})`) works. The recommended browser/mobile provider is [`@qrlwallet/connect`](https://github.com/DigitalGuards/myqrlwallet-connect) v2+, which opens a post-quantum (ML-KEM-768) encrypted session from a dApp to the MyQRLWallet mobile app via QR code or deep link.

```bash
npm install @qrlwallet/connect
```

For signed records (Phase 4), also install:

```bash
npm install @theqrl/mldsa87
```

## Usage

```ts
import { QRLConnect } from "@qrlwallet/connect";
import { resolveName, lookupAddress, namehash } from "@qns/sdk";

const provider = new QRLConnect({
  dappMetadata: { name: "My dApp", url: "https://example.com" },
  autoReconnect: true,
});
const uri = await provider.getConnectionURI();
// ... present the URI as a QR code or deep link to the user.

const cfg = {
  registry: "Qd812032246Fc1e53f5eC392c325b1B4A8C0C2f92", // from config/testnet.json
  provider,
};

// Forward: alice.qrl -> 24-byte QRL address bytes
const addrBytes = await resolveName("alice.qrl", cfg);

// Reverse: 20-byte EVM address -> primary name
const name = await lookupAddress("Q2E13b52fd3cda0a57f9037856B7Df971074e2489", cfg);

// Client-side namehash (EIP-137)
const node = namehash("alice.qrl");
```

## What's implemented

| API | Status |
|---|---|
| `namehash(name) -> Uint8Array` | Working (keccak256 via `@noble/hashes`) |
| `nodeToHex(node) -> 0x...` | Working |
| `getResolver(name, cfg) -> string \| null` | Working (live on testnet) |
| `resolveName(name, cfg) -> Uint8Array \| null` | Working — returns 24-byte QRL wallet-display form |
| `resolveLegacyAddr(name, cfg) -> string \| null` | Working — returns 20-byte EVM address |
| `lookupAddress(addr, cfg) -> string \| null` | Working — ENSIP-19 reverse via `addr.reverse` |
| `verifyReverse(addr, cfg) -> string \| null` | Working — `lookupAddress` + forward-confirm |

## Normalization

This SDK assumes labels are **already normalized** per [ENSIP-15](https://docs.ens.domains/ensip/15). Use [`@adraffy/ens-normalize`](https://github.com/adraffy/ens-normalize.js) on untrusted input *before* calling `namehash`.

## Address format notes

- **20-byte EVM form** (`Q...40hex` or `0x...40hex`) is what `msg.sender` resolves to on-chain and what you pass to `lookupAddress` / `resolveLegacyAddr`.
- **24-byte QRL wallet-display form** is returned by `resolveName` (the primary forward record). Per `docs/ADDRESS-COMPATIBILITY.md` (Path A), we store it as `bytes` via the `IQRLAddrResolver` profile so tooling can recover the full wallet representation.

## Development

```bash
npm install
npm run build
npm test
```

## License

GPL-3.0. See `../LICENSE`.
