# @qns/sdk

TypeScript helpers for QNS on QRL 2.0.

## Address and ABI model

- Native addresses are `Q` followed by 128 hex characters.
- `resolveName()` and `resolveLegacyAddr()` return the same native address string.
- Reverse labels hash the 128 lowercase address hex characters without a prefix.
- Contract calls use `qrl_call` and 64-byte ABI words.
- `bytes32` namehash arguments are left-aligned and zero-padded to 64 bytes.

## Usage

```ts
import { lookupAddress, qnsDigest, resolveName, verifyReverse } from "@qns/sdk";

const config = {
  registry: "Q" + "1".repeat(128),
  provider,
};

const address = await resolveName("alice.qrl", config);
const name = address ? await lookupAddress(address, config) : null;
const verifiedName = address ? await verifyReverse(address, config) : null;
const digest = qnsDigest(new TextEncoder().encode("record payload"));
```

Any provider implementing `request({ method, params })` can be used. QNS sends reads through the QRL `qrl_call` method.

## ML-DSA helpers

`qnsDigest()` computes a 64-byte SHAKE256 digest. `encodeMLDSA87VerifyInput()` creates the raw precompile payload:

```text
digest[64] || signature[4627] || publicKey[2592] || context[0..255]
```

The canonical QNS context is `QNS-SIGN-v1`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
