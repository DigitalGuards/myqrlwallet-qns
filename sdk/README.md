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
const unverifiedName = address ? await lookupAddress(address, config) : null;
const verifiedName = address ? await verifyReverse(address, config) : null;
const digest = qnsDigest(new TextEncoder().encode("record payload"));
```

Any provider implementing `request({ method, params })` can be used. QNS sends reads through the QRL `qrl_call` method.

`lookupAddress()` returns an unverified, attacker-controlled reverse string and is unsafe for identity display. Use `verifyReverse()` for display: it returns the normalized name whose forward record matches the supplied address, or `null` when confirmation fails. For example, a stored `ALIce.QRL` returns `alice.qrl` after successful verification.

## ML-DSA helpers

`qnsDigest()` computes a 64-byte SHAKE256 digest. `encodeMLDSA87VerifyInput()` creates the raw precompile payload:

```text
digest[64] || publicKey[2592] || signature[4627] || contextLength[1] || context[0..255]
```

The canonical QNS context is `QNS-SIGN-v1`.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run typecheck` runs formatting and type-aware ESLint checks through
`pretypecheck`, then checks production code and tests. The existing SDK CI job
calls this command, so all three checks are required in CI.

Production TypeScript uses the strict compiler options and the
`strict-type-checked` ESLint rules. Type assertions, explicit `any`, non-null
assertions, TypeScript directives, and inline lint overrides fail the checks.
Const assertions are allowed. The Connect composition test validates its
transport mock at runtime and uses the same rules as production code.

Provider responses enter as `unknown` and pass a runtime hex-byte guard before
ABI decoding. Malformed responses throw `TypeError` without coercing the returned
value to a string.

## Registration and ownership

`parseNetworkConfig(unknown)` validates the existing deployment JSON format and retains only browser-safe fields. `assertDeployment({ config, provider })` checks network identity, code and registry/registrar/resolver wiring. `registrationName(input)` accepts a label or a full `.qrl` name and returns the normalized spelling, label hash and namehash. `isAvailable` calls the FIFS registrar and requires a canonical 64-byte boolean response.

`registerName(input, options)` takes the network config, a read provider, a wallet provider, the account, the `extension` or `relay` transport, an optional-primary flag and an `onUpdate` callback. It confirms each required transaction before submitting the next: registration, resolver selection, address record, published forward name record, then optional primary name. It verifies forward and reverse results. Repeated calls skip correct records owned by the same account. Every write rechecks the wallet account and network. A failed, interrupted or unconfirmed step stops the sequence. Consumers must retain unresolved transaction state before offering a retry; `checkRegistrationTransaction` binds a recovery receipt to the exact expected operation and detects consumed nonces. `readRegistrationState` reads ownership, resolver, address, spelling and verified reverse records at one block. `waitForReceipt` alone only checks receipt status. The approval update identifies the pending step. After the wallet returns a transaction hash, the SDK reads the submitted transaction's nonce from the chain through `qrl_getTransactionByHash` and includes it in subsequent updates once available. An approval interrupted before a hash is returned remains unresolved until a matching receipt or consumed nonce establishes settlement, or the user explicitly discards recovery state. `readRegistrationState` identifies completed records; an unresolved transaction retains priority over a complete snapshot.

`listOwnedNames(account, context, knownNames, signal)` scans registry events with native 64-byte topics in pages of at most 2,000 blocks and verifies current ownership at a fixed block. Results contain the node hash, label hash and an optional verified spelling. Plaintext labels are absent from the registrar ABI and event log. The app publishes spellings through the existing resolver `setName(bytes32,string)` call. Its `NameChanged` logs, verified primary names and supplied hints provide preimages. Every candidate spelling must hash to its logged node. Unknown spellings remain `null`. Endpoint block-range refusals reduce the page size and retry the same starting block; an unspecified range limit uses bounded halving. Shared network, reverse-record and log errors propagate. Each candidate ownership or record failure returns an error entry with `records: null`, `primary: null`, and an `error` message; consumers must offer a retry and withhold setup actions for that entry. Healthy entries retain their records and verified primary status. An ownership-error entry identifies a candidate whose current ownership still needs verification. Primary forward verification runs within each candidate read, so a failed primary resolver also stays local to its entry. Cancellation always propagates. `deploymentBlock` is optional and, when supplied, must be a positive safe integer naming the QNSRegistry deployment receipt block. Omitted values remain absent in parsed configs so consumers can show a clear incomplete-list notice. Scans with that fallback start at block 1. Log queries never start at genesis. Providers must propagate JSON-RPC error messages, including those returned with HTTP 400, so range limits can be recognized.
