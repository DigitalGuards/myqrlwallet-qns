const test = require("node:test");
const assert = require("node:assert/strict");
const { planHandoff, runHandoff } = require("../../scripts/lib/handoff");
const { governancePolicy, readPowerState } = require("../../scripts/lib/governance");
const { governanceMock, loadCli, DEPLOYER, FINAL, CONTROLLER, OTHER, CONTRACTS } = require("./helpers/governanceMock");

const quiet = () => {};
const run = (fixture, options = {}) => runHandoff({ ...fixture, account: { address: DEPLOYER }, log: quiet, ...options });
const sequence = [
    "Root.setController(address,bool)", "Root.setSubnodeOwner(bytes32,address)",
    "Root.lock(bytes32)", "Root.lock(bytes32)", "Root.setController(address,bool)",
    "Root.transferOwnership(address)", "ReverseRegistrar.transferOwnership(address)",
];

test("handoff orders controllers, reverse ownership, locks, revocation and ownership transfers", async () => {
    const fixture = await governanceMock();
    const plan = await run(fixture);
    assert.deepEqual(fixture.writes.map((tx) => `${tx.contract}.${tx.method}`), sequence);
    assert.deepEqual(plan.transactions[0].args, [CONTROLLER, true]);
    assert.deepEqual(plan.transactions[4].args, [DEPLOYER, false]);
    assert.equal(plan.after.nodes.reverse, FINAL);
    assert.equal(plan.after.nodes["addr.reverse"], CONTRACTS.ReverseRegistrar);
    assert.deepEqual(plan.after.owners, { Root: FINAL, ReverseRegistrar: FINAL });
    assert.deepEqual(plan.after.locks, { qrl: true, reverse: true });
    assert.equal(fixture.networkChecks, 1 + fixture.writes.length);
    assert.equal(fixture.genesisChecks, fixture.networkChecks);
});

test("dry run prints exact calls and before/after snapshots without signing, estimating or sending", async () => {
    const fixture = await governanceMock();
    const output = [];
    const plan = await run(fixture, { dryRun: true, account: undefined, log: (line) => output.push(line) });
    assert.equal(plan.before.nodes.reverse, DEPLOYER);
    assert.equal(plan.after.nodes.reverse, FINAL);
    assert.equal(plan.before.controllers.Root[DEPLOYER], true);
    assert.equal(plan.after.controllers.Root[DEPLOYER], false);
    assert.equal(plan.transactions.length, 7);
    assert.deepEqual(JSON.parse(output[1].slice(output[1].indexOf("\n") + 1)), plan.transactions);
    for (const tx of plan.transactions) {
        assert.equal(tx.from, DEPLOYER);
        assert.equal(tx.to, CONTRACTS[tx.contract]);
        assert.match(tx.data, /^0x[0-9a-f]+$/);
        assert.equal(tx.value, "0x0");
        assert.equal(BigInt(tx.chainId), 3151999n);
    }
    assert.match(output.join("\n"), /Before state:[\s\S]*Projected after state[^\n]*:[\s\S]*none sent/);
    assert.equal(fixture.estimates, 0);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.state.nodes.reverse, DEPLOYER);
});

test("reruns finish after interruption at every transaction boundary, including after Root transfer", async (t) => {
    for (let completed = 0; completed <= 7; completed++) {
        await t.test(`${completed} completed`, async () => {
            const fixture = await governanceMock();
            fixture.failAt = completed;
            if (completed < 7) await assert.rejects(run(fixture), /Simulated interruption/);
            else await run(fixture);
            assert.equal(fixture.writes.length, completed);
            fixture.failAt = null;
            const resumed = await run(fixture);
            assert.equal(resumed.transactions.length, 7 - completed);
            assert.equal(fixture.writes.length, 7);
            assert.equal((await run(fixture)).transactions.length, 0);
            assert.equal(fixture.writes.length, 7);
        });
    }
});

test("supports an empty reviewed set, Root-owned reverse and explicit unlocked labels", async () => {
    const fixture = await governanceMock();
    fixture.config.handoff = { finalOwner: FINAL, rootControllers: [], reverseOwner: "root", lockLabels: [] };
    const plan = await run(fixture);
    assert.equal(plan.after.nodes.reverse, CONTRACTS.Root);
    assert.deepEqual(plan.after.locks, { qrl: false, reverse: false });
    assert.deepEqual(fixture.writes.map((tx) => tx.method), [
        "setSubnodeOwner(bytes32,address)", "setController(address,bool)", "transferOwnership(address)", "transferOwnership(address)",
    ]);
});

test("removes an additional deployer ReverseRegistrar controller role before transfers", async () => {
    const fixture = await governanceMock();
    fixture.state.controllers.ReverseRegistrar[DEPLOYER] = true;
    await run(fixture);
    assert.equal(fixture.state.controllers.ReverseRegistrar[DEPLOYER], false);
    assert.equal(fixture.writes[5].contract, "ReverseRegistrar");
    assert.equal(fixture.writes[5].method, "setController(address,bool)");
});

for (const [name, mutate, pattern] of [
    ["wrong qrl owner before locking", (f) => { f.state.nodes.qrl = DEPLOYER; }, /Unexpected qrl owner/],
    ["reverse locked with deployer owner", (f) => { f.state.locks.reverse = true; }, /Refusing locked reverse/],
    ["unexpected reverse owner", (f) => { f.state.nodes.reverse = OTHER; }, /reverse owner before handoff/],
    ["unexpected Root owner", (f) => { f.state.owners.Root = OTHER; }, /Unexpected Root owner/],
    ["unexpected ReverseRegistrar owner", (f) => { f.state.owners.ReverseRegistrar = OTHER; }, /Unexpected ReverseRegistrar owner/],
    ["unreviewed Root controller", (f) => { f.state.controllers.Root[OTHER] = true; }, /Unreviewed Root controller/],
    ["unreviewed reverse controller", (f) => { f.state.controllers.ReverseRegistrar[OTHER] = true; }, /Unreviewed ReverseRegistrar controller/],
    ["missing Root controller authority", (f) => { f.state.controllers.Root[DEPLOYER] = false; }, /lacks Root controller/],
    ["deployer as final owner", (f) => { f.config.handoff.finalOwner = DEPLOYER; }, /differ from deployer/],
    ["deployer in reviewed controllers", (f) => { f.config.handoff.rootControllers.push(DEPLOYER); }, /exclude deployer/],
    ["zero final owner", (f) => { f.config.handoff.finalOwner = `Q${"00".repeat(64)}`; }, /must be nonzero/],
    ["missing contract code", (f) => { delete f.state.code[CONTRACTS.Root]; }, /Missing contract code/],
    ["unconfigured existing lock", (f) => { f.config.handoff.lockLabels = []; f.state.locks.qrl = true; }, /irreversible qrl lock/],
]) {
    test(`refuses ${name} before sending any transaction`, async () => {
        const fixture = await governanceMock();
        mutate(fixture);
        await assert.rejects(run(fixture), pattern);
        assert.equal(fixture.writes.length, 0);
    });
}

test("refuses a lock if ownership changes during gas estimation", async () => {
    const fixture = await governanceMock();
    fixture.onEstimate = (method) => { if (method === "lock(bytes32)") fixture.state.nodes.qrl = OTHER; };
    await assert.rejects(run(fixture), /Refusing to lock qrl/);
    assert.ok(fixture.writes.every((tx) => tx.method !== "lock(bytes32)"));
});

test("checks confirmation postconditions and rejects a failed receipt", async () => {
    const fixture = await governanceMock();
    fixture.applyWrites = false;
    await assert.rejects(run(fixture), /postcondition/);
    const failed = await governanceMock();
    failed.web3.qrl.sendTransaction = async () => ({ status: 0n });
    await assert.rejects(run(failed), /transaction failed/);
});

test("wrong signer fails before writes", async () => {
    const fixture = await governanceMock();
    await assert.rejects(run(fixture, { account: { address: OTHER } }), /Signing account/);
    assert.equal(fixture.writes.length, 0);
});

for (const kind of ["chain", "genesis", "missing genesis", "chain drift", "genesis drift"]) {
    test(`checks ${kind} before any write`, async () => {
        const fixture = await governanceMock();
        let checks = 0;
        if (kind === "chain") fixture.web3.qrl.getChainId = async () => 1n;
        if (kind === "genesis") fixture.web3.qrl.getBlock = async () => ({ hash: `0x${"00".repeat(32)}` });
        if (kind === "missing genesis") delete fixture.config.genesisHash;
        if (kind === "chain drift") fixture.web3.qrl.getChainId = async () => ++checks === 1 ? 3151999n : 1n;
        if (kind === "genesis drift") fixture.web3.qrl.getBlock = async () => ({ hash: ++checks === 1 ? fixture.config.genesisHash : `0x${"00".repeat(32)}` });
        await assert.rejects(run(fixture), /chainId|genesis/);
        assert.equal(fixture.writes.length, 0);
    });
}

test("pure planning preserves the supplied snapshot", async () => {
    const fixture = await governanceMock();
    const policy = governancePolicy(fixture.config, fixture.sdk);
    const before = await readPowerState(fixture.web3, policy, fixture.sdk);
    const original = structuredClone(before);
    planHandoff(fixture.config, before, fixture.sdk);
    assert.deepEqual(before, original);
});

test("dry-run CLI skips the secret environment file and signer loader", async () => {
    const fixture = await governanceMock();
    const cli = loadCli("handoff.js", fixture, {
        dotenv: { config() { assert.fail("Dry run read the secret environment file"); } },
        "./lib/loadDeployer": { loadDeployerFromEnvironment() { assert.fail("Dry run loaded a signer"); } },
        "./lib/handoff": { runHandoff: (options) => runHandoff({ ...options, log: quiet }) },
    });
    const plan = await cli.main(["--dry-run"]);
    assert.equal(plan.transactions.length, 7);
    assert.equal(fixture.writes.length, 0);
    await assert.rejects(cli.main(["--dryrun"]), /Usage/);
});
