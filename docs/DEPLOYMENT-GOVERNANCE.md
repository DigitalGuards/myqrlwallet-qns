# Deployment governance

The default testnet deployment retains alpha administration. The deployer owns Root, is an enabled Root controller, owns ReverseRegistrar, and directly owns `reverse` in QNSRegistry. Root owns the root node, FIFSQRLRegistrar owns `qrl`, and ReverseRegistrar owns `addr.reverse`. Both top-level labels start unlocked. ReverseRegistrar starts with an empty controller set. QRLPublicResolver's immutable trusted reverse registrar is ReverseRegistrar, whose owner can also change its default resolver.

Root ownership and controller authority are separate powers. Only controllers can assign unlocked top-level labels; the owner manages controllers, locks labels and sets the root resolver. ReverseRegistrar controllers can claim and name reverse records for other addresses. Ownable transfers take effect in one transaction, with no acceptance step. Renunciation is reachable and leaves controllers enabled. The handoff script never renounces ownership.

## Configuration

Build the SDK with `npm --prefix sdk ci` and `npm run sdk:build`. Use the existing ignored deployment record selected by `QNS_CONFIG`. Retain its contract addresses, `deployer`, chain ID, genesis hash and registry `deploymentBlock`. A record written before deployment saved `deployer` needs that field added by hand: the address that `Root.owner()` returns. Governance commands require an explicit genesis hash even for loopback networks. Add the following fields, replacing the address placeholder with the reviewed native 64-byte address:

```json
{
  "handoff": {
    "finalOwner": "<reviewed Q-prefixed 64-byte governance address>",
    "rootControllers": [],
    "reverseOwner": "finalOwner",
    "lockLabels": ["qrl", "reverse"]
  },
  "powerCheck": {
    "controllerMode": "events",
    "controllerCandidates": { "Root": [], "ReverseRegistrar": [] },
    "reverseControllers": []
  }
}
```

`rootControllers` is the reviewed final set and may be empty. `finalOwner` and the expected controller sets must exclude the deployer. `lockLabels` explicitly selects either label, both labels, or an empty array. The expected final owner of `qrl` is always the configured FIFSQRLRegistrar. `reverseControllers` describes existing reviewed ReverseRegistrar controllers; the handoff checks that set and removes a deployer controller role if present. Unexpected active controllers stop the handoff before any write, so they must be reviewed and resolved first.

`reverseOwner` has two choices:

| Choice | Final direct owner of `reverse` | Consequence |
|---|---|---|
| `finalOwner` | The configured governance account | That account and its approved registry operators can manage the `reverse` node and its children, including reassignment of `addr.reverse`. |
| `root` | The deployed Root contract | Root's current interface can reassign unlocked top-level labels, but has no method to manage children of `reverse`. Locking `reverse` while Root owns it permanently prevents changing its owner and prevents replacing `addr.reverse` through that parent. |

Locking a label permanently disables Root's ability to reassign it. Its existing registry owner retains the owner's own registry powers. A deployer-owned `reverse` locked in Root therefore leaves the deployer's parent-level authority in place permanently with respect to Root reassignment. The planner refuses that state. Review the final parent owner and the existing `addr.reverse` owner before any lock, particularly when choosing `root`.

The strict power check requires code at every active administrative holder, including a configured final owner and reviewed controllers. An externally owned final account can receive the handoff but will fail that check. Review the governance contract's execution and recovery capabilities separately; code presence alone establishes neither multisignature governance nor correct governance behavior.

## Ordered handoff checklist

1. Pin and verify the chain ID and genesis, verify that the registry root belongs to Root, `qrl` belongs to FIFSQRLRegistrar, and `addr.reverse` belongs to ReverseRegistrar. Check both Ownable owners, both controller sets, both locks, the default resolver and its trusted reverse registrar. Resolve every unexpected controller before starting.
2. Add the reviewed Root controllers, in configured order.
3. Use Root to assign `reverse` to the configured final owner of `reverse`.
4. When configured, lock `qrl` and then `reverse`. Check the exact final owner before each lock: FIFSQRLRegistrar for `qrl`, and the configured account or Root for `reverse`.
5. Revoke the deployer's Root controller role. Revoke its ReverseRegistrar controller role too if one is active.
6. Transfer Root ownership, then ReverseRegistrar ownership, to `finalOwner`.
7. Run the strict power check and retain the final table with the reviewed configuration. Confirm that the immutable trusted reverse registrar still equals the owner of `addr.reverse`.

With the target record selected in the environment, first review `npm run handoff -- --dry-run`. It prints the before state, ordered calls including `from`, `to`, `chainId`, `value`, method arguments and exact 64-byte ABI calldata, and the projected after state. Gas and nonce are selected at execution. The projected snapshot retains its original block and code observations. Dry-run loads no signing key, estimates no gas and sends no transactions.

When ready to execute the reviewed plan, run `npm run handoff` with the same `QNS_CONFIG` and the deployer's signing configuration used by deployment. Each write rechecks chain and genesis, each lock checks live ownership again immediately before submission, and every confirmed transaction is followed by a state check. Keep governance activity quiescent during the sequence: separate transactions cannot provide an atomic cross-contract lock against a concurrent administrator.

Rerunning after an interruption reads the live state and skips completed actions. This includes an interruption after Root ownership moves and before ReverseRegistrar ownership moves. A failed receipt, missing postcondition, unexpected ownership or new controller stops execution. Review unresolved transaction settlement before retrying after an RPC timeout. An external early ownership transfer or an incorrect irreversible lock can require separate governance recovery.

Deployment prints the handoff command after saving its deployment record, including when `handoff.finalOwner` is configured. It leaves execution to the operator. Existing configurations preserve the current testnet behavior.

## Read-only power check

Run `npm run check:powers` with the same `QNS_CONFIG`. The output starts with the snapshot block and controller coverage, followed by a table with columns `Power | Observed | Expected | Code | Status` and a violation count. Full addresses are printed. Disabled controller candidates remain visible with `Code` set to `-`, since they hold no controller power.

The table covers Root ownership and controllers, ReverseRegistrar ownership and controllers, the direct owners of the root node, `qrl`, `reverse` and `addr.reverse`, both top-level lock states, ReverseRegistrar's default resolver, the resolver's trusted reverse registrar, and the equality between that trusted address and the owner of `addr.reverse`. Expectations come from the configured deployed contracts and handoff fields. Missing handoff expectations are reported explicitly.

Default `events` mode scans `ControllerChanged` logs for both contracts from `deploymentBlock` through one fixed head, in pages of at most 2,000 blocks, reducing the page size on range-limit errors. A missing `deploymentBlock` starts at block 1. Event addresses, configured candidates, expected controllers and known owners are probed through the live `controllers(address)` getters at the same block; historical revoked entries do not count as current authority. Use the actual registry deployment block and an RPC with complete history. Log or read failures fail the command.

For an RPC without historical logs, set `controllerMode` to `list` and supply explicit `controllerCandidates.Root` and `controllerCandidates.ReverseRegistrar` arrays containing every reviewed candidate. The table states that unlisted controllers may exist. This mode checks only the supplied candidates and known holders; its success is scoped to that set. Event mode provides broader discovery subject to the RPC's completeness.

The command exits 1 for `NO_CODE`, `UNEXPECTED_HOLDER`, `MISSING_CONTROLLER`, `LOCK_MISMATCH`, `TRUST_MISMATCH` or `MISSING_EXPECTATION`. Zero addresses and renounced owners fail through the same holder checks. `--report-only` prints all violations and exits 0 for a successfully read alpha snapshot; configuration, identity, decoding and RPC failures still exit 1. Neither mode loads a signer or sends transactions.

These scripts have mocked-provider unit coverage. They add no formal proof targets. The checker reads direct protocol authority and controller mappings; governance contract internals, its approved registry operators, RPC honesty, finality and the operational safety of a chosen governance owner require separate review. See [formal verification boundaries](FORMAL-SECURITY-VERIFICATION.md).
