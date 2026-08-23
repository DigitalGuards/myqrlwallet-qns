# Open QRL 2.0 questions

Updated 2026-08-23.

## Resolved for implementation

| Topic | Decision or evidence |
|---|---|
| Address width | go-qrl and Hyperion use 64-byte native addresses |
| ABI word width | 64 bytes |
| QNS forward record | native `addr(bytes32) returns (address)` |
| Reverse label | Keccak-256 over 128 lowercase address hex characters |
| Contract language | Hyperion only |
| Signature scheme | ML-DSA-87 with an explicit public key and context |
| QNS context | `QNS-SIGN-v1` |
| Local network | Cyyber's `qrl-package` Kurtosis package |

## Needs review before QIP submission

1. Are precompile slots 3 and 6 reserved and acceptable for SHAKE256 and ML-DSA-87 verification?
2. Should the precompiles activate from the first QRL 2.0 genesis or through a named QIP fork?
3. Is `250000` fixed gas appropriate for ML-DSA-87 verification across supported node hardware?
4. Should SHAKE256 use the proposed four-times-SHA256 gas schedule or a separately benchmarked schedule?
5. Should the verifier accept only a 64-byte digest or accept arbitrary message bytes?
6. What canonical encoding should signed QNS record messages use?
7. Which chain IDs and coin types will the public QRL 2.0 testnet and mainnet use?
8. Is `.qrl` accepted as the governed naming root?

## Network timing

The legacy public Testnet V2 deployment uses 20-byte addresses. New QNS contracts should be deployed to a 64-byte Kurtosis network until the public QRL 2.0 testnet is available and exposes matching RPC, wallet, and explorer tooling.

Current source and published container tags were temporarily out of step during the 2026-08-23 validation. `cyyber/qrysm@b53fd7c4` and `theQRL/qrl-genesis-generator@6a11fbce` accepted 64-byte withdrawal, deposit-contract, and execution addresses and produced a working network. The published Qrysm `latest` beacon and validator images identified themselves as older 2025 builds and could not provide this composition. The local scripts therefore build and label the pinned sources until upstream publishes equivalent images.
