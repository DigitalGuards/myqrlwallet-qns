# QNS roadmap

Updated 2026-08-23.

## QRL 2.0 foundation

- [x] Inspect current go-qrl, Qrysm, Hyperion, genesis generator, and Kurtosis package.
- [x] Define native 64-byte forward and reverse address behavior.
- [x] Convert QNS contract sources to Hyperion only.
- [x] Add SHAKE256 and ML-DSA verifier compiler/runtime groundwork.
- [x] Update SDK ABI encoding and address decoding for 64-byte words.
- [ ] Complete full repository validation.
- [x] Run the end-to-end deployment on a local Kurtosis network.
- [x] Verify forward and reverse resolution through the TypeScript SDK.
- [x] Verify direct and wrapped SHAKE256 and ML-DSA-87 calls.

## Signed records

- [x] Add standalone `QRLSignatureVerifier`.
- [x] Add SDK SHAKE256 and raw precompile payload helpers.
- [ ] Freeze canonical signed-record message encoding.
- [ ] Add ML-DSA public-key resolver records.
- [ ] Add signed reverse updates with nonce and expiry replay protection.
- [ ] Design optional CCIP-style off-chain record storage.

## Naming features

- [x] Registry, root, FIFS registrar, forward resolution, and reverse resolution.
- [x] Text and contenthash storage in the resolver.
- [ ] Add multichain address records if QRL ecosystem clients need them.
- [ ] Add a commit and reveal registrar with renewal economics.
- [ ] Revisit name tokenization after QRC-721 stabilizes.

## Governance and deployment

- [ ] Community review of the precompile QIP draft.
- [ ] Core-team review of slots, gas, and activation.
- [ ] QIP submission after reviewer approval.
- [ ] Fresh deployment on the public 64-byte testnet.
- [ ] Wallet and explorer integration.
- [ ] Mainnet deployment after chain ID and `.qrl` governance are final.

The legacy addresses in `config/testnet.json` are historical and will not be reused on the 64-byte chain.
