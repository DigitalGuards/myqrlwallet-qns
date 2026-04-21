# QNS: QRL Name Service

Post-quantum naming service for [QRL Zond](https://www.theqrl.org/zond). QNS is a port of [ENS v1](https://docs.ens.domains) to QRL Zond's Hyperion-compiled EVM, with the off-chain signature surface rebuilt on [ML-DSA-87](https://github.com/theQRL/qrypto.js) (`@theqrl/mldsa87`) for post-quantum safety.

> **Status: alpha scaffolding.** This repo currently contains the architectural plan and empty contract/SDK skeletons. Phase 1 (forward resolution on Testnet V2) lands real Solidity sources. See `docs/ROADMAP.md`.

## Why

ENS solves a problem QRL Zond will need the moment dApps arrive: human-readable names pointing at addresses and content. Porting ENS is cheap (namehash is keccak256, which runs natively on Hyperion; ownership is enforced by `msg.sender`, which Zond handles at consensus with ML-DSA-87). The hard parts are address representation (24-byte QRL vs 20-byte Solidity `address`) and off-chain signed records, both of which have clean fallbacks via EIP-2304's multichain `addr(bytes32,uint256)` and a future ML-DSA precompile.

Beyond name resolution, QNS adds a **pubkey resolver record** for publishing ML-DSA-87 public keys (2,592 bytes) as first-class name-indexed identity artifacts. ENS has no equivalent.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       User / dApp                            │
└───────────────────────────┬──────────────────────────────────┘
                            │ resolveName("alice.qrl")
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                      @qns/sdk (qnsjs)                        │
│  - namehash (keccak256, EIP-137)                             │
│  - registry > resolver walk, forward + reverse (ENSIP-19)    │
│  - provider: any EIP-1193 (recommended: @qrlwallet/connect)  │
└───────────────────────────┬──────────────────────────────────┘
                            │ eth_call
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                       QNS Contracts                          │
│                                                              │
│  ┌─────────────┐   ┌────────────────┐   ┌────────────────┐   │
│  │ ENSRegistry │──▶│ PublicResolver │   │ FIFSQRLRegistrar│  │
│  │  (vendored) │   │  + profiles    │   │  (custom)      │   │
│  └─────────────┘   └────────────────┘   └────────────────┘   │
│                                                              │
│  ┌────────────────┐   ┌──────────────────┐                   │
│  │ ReverseRegistrar│  │ UniversalResolver │                  │
│  └────────────────┘   └──────────────────┘                   │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
                   QRL Zond Testnet V2
                   (gqrl + qrysm, chainId 1337)
```

## Project Structure

```
myqrlwallet-qns/
├── contracts/
│   ├── solidity/             # Source of truth (ENS-style)
│   │   ├── registry/         # ENSRegistry, Root, FIFSQRLRegistrar
│   │   ├── resolvers/        # PublicResolver + profiles (IQRLAddrResolver, text, contenthash)
│   │   ├── reverseRegistrar/
│   │   ├── utils/            # UniversalResolver
│   │   └── vendored/         # Pinned ens-contracts copy (Phase 1)
│   ├── hyperion/             # Auto-synced .hyp mirrors (QuantaPool-style)
│   └── test/                 # Foundry test suite
├── sdk/                      # @qns/sdk TypeScript library
│   └── src/                  # namehash, resolveName, lookupAddress
├── scripts/                  # Deployment and maintenance
├── config/                   # Network + deployed address map
└── docs/
    ├── PORT-PLAN.md          # Full technical port plan
    ├── ADDRESS-COMPATIBILITY.md  # Path A dual-stack resolver design
    ├── CRYPTO-INTEGRATION.md # ML-DSA-87 signed records plan
    ├── ROADMAP.md            # 5-phase delivery plan
    └── OPEN-QUESTIONS.md     # 7 open questions for QRL core-devs
```

## Phases (see `docs/ROADMAP.md`)

1. **Forward resolution** (alpha, Phase 1): Registry + FIFS `.qrl` + PublicResolver, `qnsjs.resolveName()`.
2. **Reverse + UniversalResolver**: `addr.reverse`, one-RPC lookups.
3. **Records**: text, contenthash, multichain addresses.
4. **ML-DSA signed records**: ENSIP-19 reverse via signatures, CCIP-Read gateway, pubkey resolver record.
5. **Mainnet + economics**: commit/reveal registrar, pricing, QIP.

## Quick Start

```bash
# Contracts (Foundry)
forge build
forge test

# SDK (once Phase 1 lands)
cd sdk && npm install && npm run build && npm test
```

## Related

- **ENS reference**: [ensdomains/ens-contracts](https://github.com/ensdomains/ens-contracts), [docs.ens.domains](https://docs.ens.domains)
- **Crypto**: [theQRL/qrypto.js](https://github.com/theQRL/qrypto.js), `@theqrl/mldsa87` v1.1.1 (Halborn-audited 2026-03-31)
- **Provider**: [`@qrlwallet/connect`](https://github.com/DigitalGuards/myqrlwallet-connect) v2+ (post-quantum ML-KEM-768 dApp↔wallet session, EIP-1193)
- **Workspace sibling**: [`../QuantaPool`](../QuantaPool) shares the Foundry + Hyperion toolchain pattern

## License

GPL-3.0. See `LICENSE`. ENS reference sources are MIT; the `vendored/` directory includes upstream license text alongside pinned copies.
