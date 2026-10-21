# QNS registration app

React, TypeScript, Vite and Tailwind frontend for the existing Hyperion QNS contracts. It uses the QRL Blue palette and wallet patterns from the QuantaPool and QuantaSwap frontends. Connect is pinned to `5.0.2` and the shared pairing modal to `0.3.0`, matching QuantaSwap's QIP-55 integration.

## Run locally

Use Node 22.22 or newer. From the repository root:

```sh
nice -n 10 npm --prefix sdk ci
nice -n 10 npm --prefix sdk run build
nice -n 10 npm --prefix app ci
QNS_CONFIG=config/local-qip55.json nice -n 10 npm --prefix app run dev
```

`QNS_CONFIG` is relative to the repository root. An absolute path also works. The default is `config/testnet-v3.example.json`, which shows deployment pending and disables on-chain actions. A local deployment supplies `config/local-qip55.json`. The v3 deployment supplies `config/testnet-v3.json`.

Vite serves `qns-config.json` in development and writes it into `dist/` during a build. The browser loads this file at startup. The file uses the existing network-config format: `network`, `chainId`, optional `genesisHash`, `rpcUrl`, `tld`, `qrl2PrecompileSet`, optional `deploymentBlock` and the six contract addresses. A supplied `deploymentBlock` must be a positive safe integer identifying the QNSRegistry deployment receipt block. The undeployed examples use `1` as a placeholder; deployment replaces it with the receipt block. The build copies only those fields. Deployer information, historical addresses and arbitrary metadata are excluded. Serve this runtime file with `Cache-Control: no-store`. Restart the development server or rebuild after changing the selected config. The deployment record and generated build output are ignored by Git.

## Registration behavior

- Searches accept a single label or a full `.qrl` name. The SDK folds ASCII uppercase and applies its existing conservative name profile. It rejects whitespace, Unicode, empty labels, subdomain registration and reserved double-hyphen patterns.
- `FIFSQRLRegistrar.register(bytes32,address)` claims a free label. There is no registration payment, rental term, renewal or commit/reveal in this alpha contract. Every transaction still costs network gas. Availability is checked again before submission; a competing registration can still win before confirmation.
- The app confirms registration, `QNSRegistry.setResolver`, `QRLPublicResolver.setAddr`, and `QRLPublicResolver.setName(bytes32,string)` in order. Saving the forward name record publishes its spelling for discovery from other browsers. It verifies forward resolution before showing completion. A checked primary-name option adds `ReverseRegistrar.setName` and a forward-confirmed reverse lookup.
- The claim card numbers every step and explains its purpose. The current step shows the QNS contract role, short address and function before wallet approval. No Quanta is sent; each approval costs a network fee. Registration is free. Statuses distinguish waiting, wallet approval, a sent transaction awaiting the next block (about a minute on v3), done, skipped and failed. An interrupted approval without a transaction hash stays waiting until recovery checks it. Transaction links open ZondScan.
- The resolver has separate `setAddr` and `setName` functions and no multicall entry point. A fresh claim uses four approvals, or five when setting a primary name. Already-correct steps are skipped. During a claim, the approval counter, tracker rows and execution share its frozen SDK plan. Refreshes keep open and future approvals visible; submitted approvals reduce the count through transaction updates. After the claim stops, the counter uses the latest search plan. Verified completion removes the setup button, including after a fresh search or settled recovery.
- Existing owners can complete an interrupted setup. Already-correct steps are skipped. The pending step is saved per account and network before wallet approval. After the wallet returns a transaction hash, the app saves the hash and the SDK reads the submitted transaction's nonce from the chain through `qrl_getTransactionByHash`; the app saves the nonce once available. An interrupted approval remains unresolved until a matching receipt or consumed nonce establishes settlement, including when the saved claim only has a hash or request ID. Both confirmation and name-state checks preserve an unresolved request even if its records already look complete. The user can explicitly discard recovery data after checking wallet activity and cancelling any outstanding approval. A saved, consumed nonce identifies a mined replacement or cancellation. Recovery checks current ownership, resolver, address, spelling and verified reverse records at one block, then resumes from the first incomplete step. The pending panel always offers transaction lookup, direct name-state checks and discard. Transaction recovery validates the sender, contract, exact calldata, value, nonce and chain. Late relay responses require a matching saved request ID. Connect 5.0.2 exposes late IDs without an outgoing-ID hook, so its unbound responses use the explicit lookup or name-state recovery path.
- Network and wallet chain IDs, optional genesis hashes, deployed code and registrar/resolver wiring are checked. The SDK rechecks the account and network before each write. Account changes or disconnects stop subsequent steps. An already submitted transaction can still confirm.

The EIP-6963 picker accepts MyQRLWallet Extension and the upstream QRL Web3 Wallet. Web and mobile wallets use the shared `@qrlwallet/connect-ui` modal, including its QR, copy, web-wallet and app-link actions. Stored relay sessions reconnect. Fresh pairing is an explicit action; a backgrounded wallet retains its session. Wallet and app disconnect paths retire the active connection.

The displayed name state has one owner, `useNameState.refreshName`. It reads availability, ownership and the connected owner's setup records at the same chain block after searches, confirmed or skipped steps, failures, recovery checks, and account or network changes. A refresh clears the previous result while reading. Request generations and wallet/config/provider identity prevent older responses from changing the current result. Recovery reads refresh the display even when receipt validation fails or confirmation remains pending.

## Owned names and lookups

The SDK scans native 64-byte `NewOwner` event topics from `deploymentBlock` in pages of at most 2,000 blocks, then reads current owners at a fixed block. It reduces the page size when the endpoint reports a smaller range limit, retrying the same starting block. Range refusals without a numeric limit halve the page size down to one block. If `deploymentBlock` is absent, the scan starts at block 1 and My names displays a notice that the list may be incomplete. Log scans never start at genesis. This includes names transferred into the account and excludes names transferred away. RPC failures are shown explicitly.

The registrar and registry publish label hashes. They do not publish their spellings. The app publishes each claimed spelling through the existing resolver name record. It reads `NameChanged` logs and uses verified primary names plus spellings saved by searches in this browser as additional hints. Every spelling is hashed again before use. An owned record with an unknown spelling remains visible with its name hash. Searching the spelling associates it with that record. Records claimed outside this app may have no published spelling; their hashes remain visible until a verified spelling is available.

My names checks forward records and the verified primary name at the ownership snapshot. Each row states what is ready or missing. A failed ownership or record read gives that candidate its own error and Retry name records action, while other verified names retain their actions. Primary-name forward verification runs within the same per-name reads. Shared network, reverse-record and log failures remain retryable list errors. Finish name setup and Make primary name open the selected name in the claim card, refresh its state, and request only the missing approvals. Completed primary names have no setup action. This applies equally to names claimed through other apps and names transferred into the account. A resolver's stored spelling is accepted only after its hash matches the owned node.

Forward lookup supports normalized names, including subdomains. Address lookup displays a primary name only when it resolves back to the full 64-byte address.

## Checks

```sh
nice -n 10 npm --prefix app run format:check
nice -n 10 npm --prefix app run lint
nice -n 10 npm --prefix app run typecheck
nice -n 10 npm --prefix app test
nice -n 10 npm --prefix app run build
```

The SDK and app use strict type-checked lint with no type assertions except `as const`, no non-null assertions and no explicit `any`. Tests cover normalization, availability, native ABI writes, confirmed ordering, rejection, reverts, pending recovery, account/network changes, ownership transfers, wallet lifecycle and the rendered registration flow with an in-memory provider. Unit tests and browser mocks do not establish device pairing or live-network qualification. Run the wallet acceptance checks and a funded-account claim on the configured network before release.

## Lead deployment

Install root dependencies with `npm ci`. Make the compiler matching `config/hyperion-toolchain.json` available through the documented default path or the `HYPERION_COMPILER` environment variable. Supply the funded deployer's `TESTNET_SEED` through the environment. The existing loader accepts a 102-character extended-seed hex value or a 34-word ML-DSA-87 mnemonic. Keep `QNS_PUBLIC_DEV_ACCOUNT` unset for v3.

From the repository root, run:

```sh
cp -n config/testnet-v3.example.json config/testnet-v3.json
nice -n 10 npm run compile && QNS_CONFIG=config/testnet-v3.json nice -n 10 npm run deploy:testnet
```

The script requires an explicit `QNS_CONFIG` selecting an existing file. Review the copied target configuration before running it. The script validates the same schema used by the app before initialization, verifies the reviewed compiler/artifacts, chain ID, genesis and precompile capabilities, checks funding, deploys the six contracts, wires `.qrl` and `addr.reverse`, and saves the addresses plus the QNSRegistry deployment receipt block for event scanning. It verifies network identity before each write and refuses an existing populated config. The deployer retains the alpha administration roles described in the root README. A failed deployment can leave contracts on chain; retain its output and review the completed steps before another attempt.

Then build the app with `QNS_CONFIG=config/testnet-v3.json nice -n 10 npm --prefix app run build`. Publishing `dist/` and conducting a live wallet check are separate release steps. This implementation does not deploy a network or generate a deployer key.
