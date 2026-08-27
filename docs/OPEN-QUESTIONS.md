# Open QRL 2.0 questions

Updated 2026-08-24.

## Resolved for implementation

| Topic | Decision or evidence |
|---|---|
| Address width | go-qrl and Hyperion use 64-byte native addresses |
| ABI word width | 64 bytes |
| QNS forward record | native `addr(bytes32) returns (address)` |
| Reverse label | Keccak-256 over 128 lowercase address hex characters |
| Contract language | Hyperion only |
| Signature scheme | ML-DSA-87 with an explicit public key and context |
| Precompile slots | ML-DSA-87 at 3; SHAKE256 at 6 |
| Current verifier gas | 125000 unless proposal review approves another value |
| QNS context | `QNS-SIGN-v1` |
| Local network | Cyyber's `qrl-package` Kurtosis package |

## Needs review before QIP submission

1. Answered 2026-08-25: both precompiles activate from genesis on the next QRL 2.0 testnet (confirmed by the QRL implementation lead).
2. Should verifier failure return empty data or a canonical 64-byte zero word?
3. Is the current `125000` fixed gas appropriate for ML-DSA-87 verification across supported node hardware?
4. Should SHAKE256 keep the current schedule (4x the SHA256 base constant; 48 gas per 64-byte word, about 2x SHA256 per byte) or a separately benchmarked one?
5. Answered 2026-08-25: the verifier reads a fixed 64-byte message representative (the QRL implementation lead ratified 64 over the 32-byte field the earlier deployed go-qrl verifier read). Arbitrary-length message input stays out of scope.
6. What canonical encoding should signed QNS record messages use?
7. Which chain IDs and coin types will the public QRL 2.0 testnet and mainnet use?
8. Is `.qrl` accepted as the governed naming root?

## Network timing

The legacy public Testnet V2 deployment uses 20-byte addresses. New QNS contracts should be deployed to a 64-byte Kurtosis network until the public QRL 2.0 testnet is available and exposes matching RPC, wallet, and explorer tooling.

Current source and published container tags were temporarily out of step during the 2026-08-23 validation. `cyyber/qrysm@b53fd7c4` and `theQRL/qrl-genesis-generator@6a11fbce` accepted 64-byte withdrawal, deposit-contract, and execution addresses and produced a working network. The published Qrysm `latest` beacon and validator images identified themselves as older 2025 builds and could not provide this composition. The local scripts therefore build and label the pinned sources until upstream publishes equivalent images.
