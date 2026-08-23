# Questions for QIP and implementation review

1. Should slots 3 and 6 activate at a fresh QRL 2.0 genesis or at a named execution fork?
2. Are slots 3 and 6 reserved across every maintained client and network configuration?
3. Which validator CPU classes, percentile, and safety margin define the final 250000 ML-DSA-87 gas charge?
4. Should the first verifier field be named `messageRepresentative`, `digest`, or another consensus term?
5. Is pure ML-DSA-87 over a 64-byte SHAKE256 application digest the intended construction for QNS? The draft correctly avoids the distinct HashML-DSA label.
6. Which serialized cross-language vector and provenance will become normative?
7. Which identity rule binds an ML-DSA public key to a QRL account, node owner, or resolver authorization record?
8. Is `QNS-SIGN-v1` final for the first signed-record protocol, and what canonical injective record encoding will it cover?
9. Should Hyperion expose network-target metadata that rejects these builtins for pre-activation networks?
10. Is the canonical reverse label the Keccak-256 hash of all 128 lowercase hexadecimal address characters?
11. Should the public QNS ABI continue using dynamic `bytes` for a 64-byte digest until the QRL web3 codec supports `bytes64`?
12. Which independent reviewers should be listed as QIP authors, champion, and implementation reviewers?
13. Which production governance address should receive Root and ReverseRegistrar ownership, and when should the deployer's temporary Root controller role be revoked?
14. Which Hyperion-native harness should restore the 28 removed registry lifecycle tests before production?
