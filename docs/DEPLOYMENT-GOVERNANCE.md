# Deployment governance

The default testnet deployment retains alpha administration. The deployer owns Root, is an enabled Root controller, owns ReverseRegistrar, and directly owns `reverse` in QNSRegistry. Root owns the root node, FIFSQRLRegistrar owns `qrl`, and ReverseRegistrar owns `addr.reverse`. Both top-level labels start unlocked. ReverseRegistrar starts with an empty controller set. QRLPublicResolver's immutable trusted reverse registrar is ReverseRegistrar, whose owner can also change its default resolver.

Root ownership and controller authority are separate powers. Only controllers can assign unlocked top-level labels; the owner manages controllers, locks labels and sets the root resolver. ReverseRegistrar controllers can claim and name reverse records for other addresses. Ownable transfers take effect in one transaction, with no acceptance step. Never call `renounceOwnership` on Root or ReverseRegistrar. Renunciation is irreversible. Renouncing Root while any controller is enabled gives that controller permanent power over every unlocked top-level label. The handoff script never renounces ownership.

## Configuration

Build the SDK with `npm --prefix sdk ci` and `npm run sdk:build`. Use the existing ignored deployment record selected by shell `QNS_CONFIG`. Retain all six contract addresses, `deployer`, chain ID, genesis hash and registry `deploymentBlock`. A record written before deployment saved `deployer` needs that field added by hand using the original deployment account. Governance commands require an explicit genesis hash even for loopback networks. Add the following fields, replacing the address placeholder with the reviewed checksummed native 64-byte address:

```json
{
  "handoff": {
    "finalOwner": "<reviewed checksummed Q-prefixed 64-byte governance address>",
    "rootControllers": [],
    "reverseOwner": "finalOwner",
    "lockLabels": []
  },
  "powerCheck": {
    "controllerMode": "events",
    "controllerCandidates": { "Root": [], "ReverseRegistrar": [] },
    "reverseControllers": [],
    "topLevelOwners": {}
  }
}
```

`rootControllers` is the reviewed final set and may be empty. Supply `finalOwner` and every Root controller with the exact checksum from `toChecksumAddress` in `@theqrl/web3-utils`. A checksum mismatch fails without printing a corrected address. `finalOwner` must differ from the deployer and all six configured contracts, including QRLSignatureVerifier. Both expected controller sets must exclude the deployer. `lockLabels` explicitly selects either label, both labels, or an empty array. The expected final owner of `qrl` is always the configured FIFSQRLRegistrar. `reverseControllers` describes existing reviewed ReverseRegistrar controllers; the handoff checks that set and removes a deployer controller role if present.

The handoff requires `controllerMode: "events"`. Unexpected active controllers found through complete log discovery or known-candidate probes stop the plan before any write. Resolve them first. The operator must select the actual registry deployment block and an RPC with complete logs. Positive controls detect missing known history; they cannot prove that an RPC returned every unknown controller.

In events mode the registry's root-level `NewOwner` history discovers every top-level label. `qrl` and `reverse` must both appear in that history. Any other label with a nonzero owner needs an explicit `powerCheck.topLevelOwners` entry of the form `{"<32-byte labelhash>": "<reviewed owner>"}` matching its current owner. An unreviewed label stops the handoff. Additional labels with zero owners hold no power. The built-in `qrl` and `reverse` expectations come from the deployment and handoff fields.

`reverseOwner` has two choices:

| Choice | Final direct owner of `reverse` | Consequence |
|---|---|---|
| `finalOwner` | The configured governance account | That account and its approved registry operators can manage the `reverse` node and its children, including reassignment of `addr.reverse`. |
| `root` | The deployed Root contract | Root's current interface can reassign unlocked top-level labels, but has no method to manage children of `reverse`. Locking `reverse` while Root owns it permanently prevents changing its owner and prevents replacing `addr.reverse` through that parent. |

Locking a label permanently disables Root's ability to reassign it; Root has no unlock. Its existing registry owner retains its own registry powers. Locking `qrl` while the alpha FIFSQRLRegistrar owns it binds `.qrl` to that registrar forever because FIFSQRLRegistrar has no method to transfer the node. Lock `qrl` only after the long-lived registrar holds it and the deployment configuration identifies that registrar. The example leaves both labels unlocked.

For `reverse`, a lock permanently removes Root's reassignment route. A governance contract owning `reverse` retains its parent-level registry powers. Root owning a locked `reverse` permanently prevents changing its owner or replacing `addr.reverse` through that parent, because Root has no method to manage those children. Review both direct owners before locking. The dry run prints a `PERMANENT:` line for each planned lock naming the label and the owner it binds.

When the deployer currently owns `reverse`, the handoff uses `QNSRegistry.setOwner` directly, including when Root has already locked the label. This path needs no controller role. When Root or `finalOwner` currently owns an unlocked `reverse`, an enabled deployer Root controller uses `Root.setSubnodeOwner`. Other states requiring reassignment fail with the current owner and lock state.

The handoff refuses an externally owned final account or reviewed Root controller: each destination must have code at the snapshot block. The strict power check also requires code at active administrative holders. Review the governance contract's execution and recovery capabilities separately; code presence alone establishes neither multisignature governance nor correct governance behavior.

## Ordered handoff checklist

1. Pin and verify chain ID, genesis, contract code, registry back-pointers including Root's `qns()`, and the registrar base node through the SDK deployment preflight. Verify every discovered top-level owner, the root node and `addr.reverse`, both Ownable owners, both controller sets, both locks, the default resolver and its trusted reverse registrar. Resolve discovered unexpected power before starting.
2. Assign `reverse` to its configured final owner through the current owner's authorized path.
3. When configured, lock `qrl` and then `reverse`. Check the exact final owner before each lock: FIFSQRLRegistrar for `qrl`, and the configured account or Root for `reverse`.
4. Add the reviewed Root controllers, in configured order.
5. Revoke the deployer's Root controller role. Revoke its ReverseRegistrar controller role too if one is active.
6. Transfer Root ownership, then ReverseRegistrar ownership, to `finalOwner`.
7. Run the strict power check and retain the final table with the reviewed configuration. Confirm that the immutable trusted reverse registrar still equals the owner of `addr.reverse`.

With the target record selected in shell `QNS_CONFIG`, first review `npm run handoff -- --dry-run`. `npm run handoff` also defaults to a dry run. The output includes the before state, ordered calls including `from`, `to`, `chainId`, `value`, method arguments and exact 64-byte ABI calldata, the projected after state, permanent-lock consequences and a SHA-256 plan hash. The hash covers canonical JSON with sorted object keys containing chain ID, genesis hash, all six configured contracts, deployer, normalized handoff config and the ordered transactions including their step numbers. Gas and nonce are selected at execution. The projected snapshot retains its original block and code observations. Dry runs read no `.env`, load no signing key, estimate no gas and send no transactions.

When ready, use the final dry-run command `npm run handoff -- --execute <hash>` with the same shell `QNS_CONFIG`; `--execute=<hash>` is also accepted. Execution recomputes the live plan and requires an identical hash before loading a key. If npm consumes `--dry-run` and sets `npm_config_dry_run=true`, the script explains this and runs a dry run even when execution arguments were supplied. Every other argument combination is a usage error.

Only execution reads `.env` using `dotenv.parse`, after the hash matches. It passes only `TESTNET_SEED`, `QNS_PUBLIC_DEV_ACCOUNT` and `QNS_PUBLIC_DEV_CHAIN_ID` to the signer loader, with shell values taking precedence. It ignores `.env` configuration selectors and leaves `process.env` unchanged. `check:powers` never reads `.env`.

Each write rechecks chain and genesis, refuses an outstanding deployer transaction when its pending nonce exceeds its latest nonce, and checks live ownership immediately before submitting a lock. After each receipt the next snapshot waits for a head at least as high as the receipt's block, with bounded polling. A node that stays behind fails clearly. Keep governance activity quiescent during the sequence: separate transactions cannot provide an atomic cross-contract lock against a concurrent administrator.

After an interruption, wait for unresolved transactions to settle and review a fresh dry run. It omits completed actions and gives the remaining plan a new hash. Execute with that hash. This includes an interruption after Root ownership moves and before ReverseRegistrar ownership moves. A failed receipt, missing postcondition, unexpected ownership, unreviewed label or new controller stops execution. An external early ownership transfer or an incorrect irreversible lock can require separate governance recovery.

Deployment prints the handoff command after saving its deployment record, including when `handoff.finalOwner` is configured. It leaves execution to the operator. Existing configurations preserve the current testnet behavior.

## Read-only power check

Run `npm run check:powers` with the same `QNS_CONFIG`. The output starts with the snapshot block and controller coverage, followed by a table with columns `Power | Observed | Expected | Code | Status` and a violation count. Full addresses are printed. Disabled controller candidates remain visible with `Code` set to `-`, since they hold no controller power.

The table covers Root ownership and controllers, ReverseRegistrar ownership and controllers, the direct owners of the root node, every discovered top-level node and `addr.reverse`, both configured lock states, ReverseRegistrar's default resolver, the resolver's trusted reverse registrar, and its equality with the owner of `addr.reverse`. It names known labels such as `registry.owner(qrl)` and prints the label hash for other top-level rows. Expectations come from the deployed contracts, handoff fields and `powerCheck.topLevelOwners`. Enabled controllers require expectations; disabled candidates are OK without them.

Default `events` mode scans both `ControllerChanged` histories and root-level registry `NewOwner` history from `deploymentBlock` through one fixed head, in pages of at most 2,000 blocks, reducing the page size on range-limit errors. A missing `deploymentBlock` starts at block 1. One scan cache per run retains candidates, enabling events and labels; later snapshots scan only blocks after the last scanned head. Indexed `bytes32` values are left-aligned in QRVM's 64-byte topics and must have zero low halves. Event candidates, configured candidates, expected controllers and known holders are probed at the snapshot. Every enabled candidate must have an enabling event in the accumulated range, and both `qrl` and `reverse` must have a `NewOwner` event. Missing positive controls, malformed data and RPC failures stop both commands.

For read-only checks against an RPC without historical logs, set `controllerMode` to `list` and supply explicit `controllerCandidates.Root` and `controllerCandidates.ReverseRegistrar` arrays. The table states that unlisted controllers and top-level labels may exist. Success is scoped to configured candidates, configured top-level labels and known holders. The handoff refuses this mode. Event discovery remains subject to RPC completeness even with positive controls.

The command exits 1 for `NO_CODE`, `UNEXPECTED_HOLDER`, `UNEXPECTED_TOP_LEVEL`, `MISSING_CONTROLLER`, `LOCK_MISMATCH`, `TRUST_MISMATCH` or `MISSING_EXPECTATION`. Zero administrative owners and renounced owners fail through the holder checks; additional top-level labels with zero owners report OK. `--report-only` prints all violations and exits 0 for a successfully read alpha snapshot; configuration, identity, history, decoding and RPC failures still exit 1. Neither mode loads a signer or sends transactions. Both command entrypoints print available revert reasons and inner error details on failure.

These scripts have mocked-provider unit coverage. They add no formal proof targets. The checker reads direct protocol authority and controller mappings; governance contract internals, its approved registry operators, RPC honesty, finality and the operational safety of a chosen governance owner require separate review. See [formal verification boundaries](FORMAL-SECURITY-VERIFICATION.md).
