# QNS QRL 2.0 port plan

## Objective

Move QNS from the legacy 20-byte Testnet V2 deployment to a Hyperion-only QRL 2.0 stack with native 64-byte addresses and post-quantum contract verification primitives.

## Contract migration

1. Keep the ENS v1 registry ownership model and `.qrl` FIFS registrar for alpha testing.
2. Treat `contracts/hyperion/` as the sole source tree.
3. Remove Solidity generation, Foundry configuration, and Solidity-only tests.
4. Replace the dual address records with native `addr(bytes32)`.
5. Hash 128 address hex characters for reverse labels.
6. Deploy `QRLSignatureVerifier` as an isolated adapter before coupling signed writes to the resolver.

## Runtime migration

1. Add SHAKE256 and ML-DSA-87 verification to go-qrl at proposal slots 3 and 6.
2. Add typed builtins and both legacy and via-IR code generation to Hyperion.
3. Validate raw input packing, 64-byte output handling, gas charging, malformed input, and out-of-gas behavior.
4. Run the full Go suite and Hyperion semantic tests.

## SDK migration

1. Encode calldata with 64-byte ABI slots.
2. Decode native 64-byte addresses and dynamic returns.
3. Mirror the 128-character reverse-label algorithm.
4. Expose SHAKE256 digest and ML-DSA precompile-payload helpers.
5. Keep `resolveLegacyAddr` as a temporary alias to `resolveName` for callers migrating from the alpha SDK.

## Network validation

1. Launch the current `qrl-package` locally with Kurtosis.
2. Confirm the execution RPC reports a 64-byte prefunded account.
3. Compile and deploy the complete QNS stack from Hyperion artifacts.
4. Register a name, set its resolver and native address, set reverse, and verify the forward-confirmed round trip through the SDK.
5. Exercise SHAKE256 and ML-DSA verification through the deployed wrapper with shared vectors.

## Delivery boundary

The QIP draft remains local for community review. No public testnet deployment or QIP submission should occur until reviewers accept the interface, slot allocation, gas schedule, and activation plan.
