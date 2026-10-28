const test = require("node:test");
const assert = require("node:assert/strict");
const { toChecksumAddress } = require("@theqrl/web3-utils");
const { planHandoff, runHandoff, hashHandoffPlan } = require("../../scripts/lib/handoff");
const { governancePolicy, readPowerState } = require("../../scripts/lib/governance");
const { governanceMock, loadCli, DEPLOYER, FINAL, CONTROLLER, OTHER, CONTRACTS } = require("./helpers/governanceMock");

const quiet = () => {};
const preview = (fixture, options = {}) => runHandoff({ ...fixture, log: quiet, ...options, dryRun: true });
const run = async (fixture, options = {}) => {
    if (options.dryRun) return preview(fixture, options);
    const plan = await preview(fixture);
    return runHandoff({ ...fixture, account: { address: DEPLOYER }, log: quiet,
        dryRun: false, executeHash: plan.hash, ...options });
};
const sequence = [
    "QNSRegistry.setOwner(bytes32,address)", "Root.lock(bytes32)", "Root.lock(bytes32)",
    "Root.setController(address,bool)", "Root.setController(address,bool)",
    "Root.transferOwnership(address)", "ReverseRegistrar.transferOwnership(address)",
];

test("handoff orders reverse ownership, locks, controllers, revocation and ownership transfers", async () => {
    const fixture = await governanceMock();
    const plan = await run(fixture);
    assert.deepEqual(fixture.writes.map((tx) => `${tx.contract}.${tx.method}`), sequence);
    assert.deepEqual(plan.transactions[3].args, [CONTROLLER, true]);
    assert.deepEqual(plan.transactions.slice(1, 3).map((tx) => tx.args[0]), [fixture.sdk.abi.hashText("qrl"), fixture.sdk.abi.hashText("reverse")]);
    assert.deepEqual(plan.transactions[4].args, [DEPLOYER, false]);
    assert.equal(plan.after.nodes.reverse, FINAL);
    assert.equal(plan.after.nodes["addr.reverse"], CONTRACTS.ReverseRegistrar);
    assert.deepEqual(plan.after.owners, { Root: FINAL, ReverseRegistrar: FINAL });
    assert.deepEqual(plan.after.locks, { qrl: true, reverse: true });
    assert.ok(fixture.networkChecks > fixture.writes.length);
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
    fixture.config.handoff = { finalOwner: toChecksumAddress(FINAL), rootControllers: [], reverseOwner: "root", lockLabels: [] };
    const plan = await run(fixture);
    assert.equal(plan.after.nodes.reverse, CONTRACTS.Root);
    assert.deepEqual(plan.after.locks, { qrl: false, reverse: false });
    assert.deepEqual(fixture.writes.map((tx) => tx.method), [
        "setOwner(bytes32,address)", "setController(address,bool)", "transferOwnership(address)", "transferOwnership(address)",
    ]);
});

test("removes an additional deployer ReverseRegistrar controller role before transfers", async () => {
    const fixture = await governanceMock();
    fixture.setController("ReverseRegistrar", DEPLOYER, true);
    await run(fixture);
    assert.equal(fixture.state.controllers.ReverseRegistrar[DEPLOYER], false);
    assert.equal(fixture.writes[5].contract, "ReverseRegistrar");
    assert.equal(fixture.writes[5].method, "setController(address,bool)");
});

for (const [name, mutate, pattern] of [
    ["wrong qrl owner before locking", (f) => { f.state.nodes.qrl = DEPLOYER; }, /wiring mismatch/],
    ["reverse locked with Root owner", (f) => { f.state.nodes.reverse = CONTRACTS.Root; f.state.locks.reverse = true; }, /Cannot assign reverse: current owner .*locked=true/],
    ["unexpected reverse owner", (f) => { f.state.nodes.reverse = OTHER; }, /Cannot assign reverse: current owner .*locked=false/],
    ["unexpected Root owner", (f) => { f.state.owners.Root = OTHER; }, /Unexpected Root owner/],
    ["unexpected ReverseRegistrar owner", (f) => { f.state.owners.ReverseRegistrar = OTHER; }, /Unexpected ReverseRegistrar owner/],
    ["unreviewed Root controller", (f) => { f.setController("Root", OTHER, true); }, /Unreviewed Root controller/],
    ["unreviewed reverse controller", (f) => { f.setController("ReverseRegistrar", OTHER, true); }, /Unreviewed ReverseRegistrar controller/],
    ["missing Root controller authority", (f) => { f.state.nodes.reverse = CONTRACTS.Root; f.state.controllers.Root[DEPLOYER] = false; }, /Cannot assign reverse/],
    ["deployer as final owner", (f) => { f.config.handoff.finalOwner = toChecksumAddress(DEPLOYER); }, /differ from deployer/],
    ["deployer in reviewed controllers", (f) => { f.config.handoff.rootControllers.push(toChecksumAddress(DEPLOYER)); }, /exclude deployer/],
    ["zero final owner", (f) => { f.config.handoff.finalOwner = `Q${"00".repeat(64)}`; }, /must be nonzero/],
    ["missing contract code", (f) => { delete f.state.code[CONTRACTS.Root]; }, /No contract code/],
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
        await assert.rejects(run(fixture), /chainId|genesis|Select chain/);
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
    assert.equal((await cli.main([])).hash, plan.hash);
    await assert.rejects(cli.main(["--dryrun"]), /Usage/);
});

test("dry run prints a permanent consequence for each planned lock and the exact execute command", async () => {
    const fixture = await governanceMock();
    const output = [];
    const plan = await preview(fixture, { log: (line) => output.push(line) });
    assert.deepEqual(output.filter((line) => line.startsWith("PERMANENT:")), [
        `PERMANENT: locking qrl binds Root assignment to owner ${CONTRACTS.FIFSQRLRegistrar}; Root has no unlock.`,
        `PERMANENT: locking reverse binds Root assignment to owner ${FINAL}; Root has no unlock.`,
    ]);
    assert.match(plan.hash, /^[0-9a-f]{64}$/);
    assert.equal(output.at(-1), `With the same QNS_CONFIG, execute this plan: npm run handoff -- --execute ${plan.hash}`);
    fixture.config.handoff.lockLabels = [];
    output.length = 0;
    await preview(fixture, { log: (line) => output.push(line) });
    assert.equal(output.filter((line) => line.startsWith("PERMANENT:")).length, 0);
});

test("hash binds canonical configuration and every ordered transaction field", async () => {
    const fixture = await governanceMock();
    const plan = await preview(fixture);
    const policy = governancePolicy(fixture.config, fixture.sdk);
    const hash = (config = fixture.config, reviewed = policy, transactions = plan.transactions) => hashHandoffPlan(config, reviewed, transactions);
    const reversed = (object) => Object.fromEntries(Object.entries(object).reverse());
    assert.equal(hash({ ...reversed(fixture.config) }, { ...reversed(policy), contracts: reversed(policy.contracts), handoff: reversed(policy.handoff) },
        plan.transactions.map(reversed)), plan.hash);
    for (const field of ["step", "contract", "method", "args", "from", "to", "value", "chainId", "data"]) {
        const transactions = structuredClone(plan.transactions);
        transactions[0][field] = field === "args" ? [] : "changed";
        assert.notEqual(hash(undefined, undefined, transactions), plan.hash, field);
    }
    assert.notEqual(hash(undefined, undefined, [...plan.transactions].reverse()), plan.hash);
    assert.notEqual(hash({ ...fixture.config, chainId: 1 }), plan.hash);
    assert.notEqual(hash({ ...fixture.config, genesisHash: `0x${"ab".repeat(32)}` }), plan.hash);
    assert.notEqual(hash(undefined, { ...policy, deployer: OTHER }), plan.hash);
    assert.notEqual(hash(undefined, { ...policy, handoff: { ...policy.handoff, lockLabels: [] } }), plan.hash);
    for (const contract of Object.keys(CONTRACTS)) {
        assert.notEqual(hash(undefined, { ...policy, contracts: { ...policy.contracts, [contract]: OTHER } }), plan.hash);
    }
});

for (const change of ["state", "configuration", "supplied hash"]) {
    test(`rejects changed ${change} before loading a key or reading .env`, async () => {
        const fixture = await governanceMock();
        const reviewed = await preview(fixture);
        if (change === "state") fixture.state.nodes.reverse = FINAL;
        if (change === "configuration") fixture.config.handoff.lockLabels = [];
        const cli = loadCli("handoff.js", fixture, {
            "node:fs": { readFileSync() { assert.fail("Loaded .env before hash verification"); } },
            "./lib/loadDeployer": { loadDeployerFromEnvironment() { assert.fail("Loaded signer before hash verification"); } },
            "./lib/handoff": { runHandoff: (options) => runHandoff({ ...options, log: quiet }) },
        });
        await assert.rejects(cli.main(["--execute", change === "supplied hash" ? "0".repeat(64) : reviewed.hash]),
            /state or configuration changed since the reviewed dry run; review a fresh dry run/);
        assert.equal(fixture.writes.length, 0);
    });
}

test("an interrupted plan requires a newly reviewed hash", async () => {
    const fixture = await governanceMock();
    const reviewed = await preview(fixture);
    fixture.failAt = 2;
    await assert.rejects(runHandoff({ ...fixture, dryRun: false, executeHash: reviewed.hash,
        account: { address: DEPLOYER }, log: quiet }), /Simulated interruption/);
    fixture.failAt = null;
    await assert.rejects(runHandoff({ ...fixture, dryRun: false, executeHash: reviewed.hash, log: quiet,
        loadAccount() { assert.fail("Old hash loaded a key"); } }), /review a fresh dry run/);
    const remaining = await preview(fixture);
    assert.notEqual(remaining.hash, reviewed.hash);
    await runHandoff({ ...fixture, dryRun: false, executeHash: remaining.hash, account: { address: DEPLOYER }, log: quiet });
    assert.equal(fixture.writes.length, 7);
});

test("npm_config_dry_run refuses execution and runs a dry run when npm consumed the flag", async () => {
    const fixture = await governanceMock();
    const cli = loadCli("handoff.js", fixture, {
        "node:fs": { readFileSync() { assert.fail("Read .env"); } },
        "./lib/loadDeployer": { loadDeployerFromEnvironment() { assert.fail("Loaded signer"); } },
        "./lib/handoff": { runHandoff: (options) => runHandoff({ ...options, log: quiet }) },
    });
    cli.process.env.npm_config_dry_run = "true";
    const reviewed = await cli.main([]);
    await cli.main(["--execute", reviewed.hash]);
    assert.match(cli.output.join("\n"), /npm consumed --dry-run; execution is refused/);
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.estimates, 0);
});

for (const equals of [false, true]) {
    test(`execute${equals ? "=" : " "}hash uses shell QNS_CONFIG and only allowlisted signer variables`, async () => {
        const fixture = await governanceMock();
        const plan = await preview(fixture);
        let envRead = 0;
        let signerEnv;
        const dotenv = require("dotenv");
        const cli = loadCli("handoff.js", fixture, {
            "node:fs": { readFileSync() { envRead++; return "QNS_CONFIG=ignored.json\nTESTNET_SEED=file-fixture\nQNS_PUBLIC_DEV_ACCOUNT=1\nQNS_PUBLIC_DEV_CHAIN_ID=3151999\nIGNORED=value\n"; } },
            dotenv: { parse: dotenv.parse, config() { assert.fail("Called dotenv.config"); } },
            "./lib/loadDeployer": { loadDeployerFromEnvironment(web3, options) { signerEnv = options.env; return { address: DEPLOYER }; } },
            "./lib/handoff": { runHandoff: (options) => runHandoff({ ...options, log: quiet }) },
        });
        cli.process.env.TESTNET_SEED = "shell-fixture";
        cli.process.env.QNS_PUBLIC_DEV_ACCOUNT = "";
        const original = { ...cli.process.env };
        await cli.main(equals ? [`--execute=${plan.hash}`] : ["--execute", plan.hash]);
        assert.deepEqual(fixture.configSelectors, ["fixture.json"]);
        assert.deepEqual({ ...signerEnv }, { TESTNET_SEED: "shell-fixture", QNS_PUBLIC_DEV_ACCOUNT: "", QNS_PUBLIC_DEV_CHAIN_ID: "3151999" });
        assert.deepEqual(cli.process.env, original);
        assert.equal(envRead, 1);
        assert.equal(fixture.writes.length, 7);
    });
}

test("all unsupported CLI arguments are usage errors with exit code one", async () => {
    const fixture = await governanceMock();
    for (const argv of [["--execute"], ["--execute", "invalid"], ["--dry-run", "--dry-run"],
        ["--execute", "0".repeat(64), "--dry-run"], ["--execute="], ["--unknown"]]) {
        const cli = loadCli("handoff.js", fixture, {}, { entry: true, argv });
        await new Promise(setImmediate);
        assert.equal(cli.process.exitCode, 1);
        assert.match(cli.errors.flat().join(" "), /Usage:/);
    }
    assert.equal(fixture.writes.length, 0);
});

for (const field of ["finalOwner", "rootControllers"]) {
    test(`requires the exact checksum for ${field} without suggesting a corrected address`, async () => {
        const fixture = await governanceMock();
        const correct = toChecksumAddress(field === "finalOwner" ? FINAL : CONTROLLER);
        const mistyped = correct.replace(/[a-fA-F]/, (letter) => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
        if (field === "finalOwner") fixture.config.handoff.finalOwner = mistyped;
        else fixture.config.handoff.rootControllers = [mistyped];
        await assert.rejects(preview(fixture), (error) => {
            assert.match(error.message, /must be the checksummed address/);
            assert.equal(error.message.includes(correct), false);
            return true;
        });
        if (field === "finalOwner") fixture.config.handoff.finalOwner = FINAL;
        else fixture.config.handoff.rootControllers = [CONTROLLER];
        await assert.rejects(preview(fixture), /must be the checksummed address/);
    });
}

for (const [name, address] of Object.entries(CONTRACTS)) {
    test(`refuses ${name} as finalOwner`, async () => {
        const fixture = await governanceMock();
        fixture.config.handoff.finalOwner = toChecksumAddress(address);
        await assert.rejects(preview(fixture), /differ from every configured contract/);
        assert.equal(fixture.writes.length, 0);
    });
}

for (const destination of [FINAL, CONTROLLER]) {
    test(`requires code at reviewed destination ${destination.slice(0, 5)}`, async () => {
        const fixture = await governanceMock();
        delete fixture.state.code[destination];
        await assert.rejects(preview(fixture), /destination must have code/);
        assert.equal(fixture.writes.length, 0);
    });
}

for (const locked of [false, true]) {
    test(`deployer-owned reverse uses registry authorization with locked=${locked} and no controller role`, async () => {
        const fixture = await governanceMock();
        fixture.state.controllers.Root[DEPLOYER] = false;
        fixture.state.locks.reverse = locked;
        await run(fixture);
        assert.equal(fixture.writes[0].contract, "QNSRegistry");
        assert.equal(fixture.writes[0].method, "setOwner(bytes32,address)");
        assert.equal(fixture.state.nodes.reverse, FINAL);
    });
}

for (const current of [CONTRACTS.Root, FINAL]) {
    test(`Root controller assigns reverse from ${current === FINAL ? "finalOwner" : "Root"}`, async () => {
        const fixture = await governanceMock();
        fixture.state.nodes.reverse = current;
        if (current === FINAL) fixture.config.handoff.reverseOwner = "root";
        await run(fixture);
        assert.equal(fixture.writes[0].contract, "Root");
        assert.equal(fixture.writes[0].method, "setSubnodeOwner(bytes32,address)");
    });
}

test("handoff refuses list-mode coverage before reading or writing", async () => {
    const fixture = await governanceMock();
    fixture.config.powerCheck = { controllerMode: "list", controllerCandidates: { Root: [], ReverseRegistrar: [] } };
    await assert.rejects(preview(fixture), /requires powerCheck.controllerMode events/);
    assert.equal(fixture.calls.length, 0);
});

for (const contract of ["Root", "FIFSQRLRegistrar", "ReverseRegistrar", "QRLPublicResolver", "baseNode"]) {
    test(`wiring preflight refuses incorrect ${contract} pointer before key loading`, async () => {
        const fixture = await governanceMock();
        if (contract === "baseNode") fixture.state.baseNode = fixture.sdk.abi.hashText("wrong");
        else fixture.state.pointers[contract] = OTHER;
        await assert.rejects(runHandoff({ ...fixture, dryRun: false, executeHash: "0".repeat(64), log: quiet,
            loadAccount() { assert.fail("Loaded a signer for incorrect wiring"); } }), /wiring mismatch/);
        assert.equal(fixture.writes.length, 0);
    });
}

test("pending nonce blocks every send until a fresh reviewed run", async () => {
    const fixture = await governanceMock();
    fixture.pendingNonce = 1n;
    await assert.rejects(run(fixture), /the deployer has a pending transaction; wait until it settles, then review a fresh dry run/);
    assert.equal(fixture.writes.length, 0);
    fixture.pendingNonce = null;
    fixture.onReceipt = () => { fixture.pendingNonce = BigInt(fixture.writes.length + 1); };
    await assert.rejects(run(fixture), /the deployer has a pending transaction/);
    assert.equal(fixture.writes.length, 1);
    assert.deepEqual(fixture.nonceQueries, ["latest", "pending", "latest", "pending", "latest", "pending"]);
});

test("after receipts the snapshot waits for a lagging head before reading state", async () => {
    const fixture = await governanceMock();
    let lagging = 0;
    let floor = 0n;
    const call = fixture.web3.qrl.call;
    fixture.web3.qrl.call = async (tx, block) => {
        assert.ok(block === "latest" || BigInt(block) >= floor);
        return call(tx, block);
    };
    fixture.onReceipt = (receipt) => { floor = receipt.blockNumber; lagging = 2; };
    fixture.web3.qrl.getBlockNumber = async () => lagging-- > 0 ? fixture.head - 1n : fixture.head;
    await run(fixture, { pollIntervalMs: 0 });
    assert.equal(fixture.writes.length, 7);
});

test("a node that stays behind the receipt fails after bounded head polls", async () => {
    const fixture = await governanceMock();
    let polls = 0;
    fixture.onReceipt = () => {
        fixture.web3.qrl.getBlockNumber = async () => { polls++; return fixture.head - 1n; };
    };
    await assert.rejects(run(fixture, { pollIntervalMs: 0, headAttempts: 3 }), /stays behind required block 10/);
    assert.equal(polls, 3);
    assert.equal(fixture.writes.length, 1);
});

for (const script of ["handoff.js", "check-powers.js"]) {
    test(`${script} prints messages and nested revert details on failure`, async () => {
        const fixture = await governanceMock();
        const error = Object.assign(new Error("RPC rejected"), { reason: "onlyOwner", innerError: new Error("inner revert"),
            cause: { message: "execution reverted", data: "0x1234" }, data: { reason: "nested reason" } });
        const cli = loadCli(script, fixture, {
            "./lib/governance": { loadGovernanceConfig: async () => { throw error; } },
        }, { entry: true });
        await new Promise(setImmediate);
        assert.equal(cli.process.exitCode, 1);
        const output = cli.errors.flat().map((value) => typeof value === "object" ? String(value.message ?? JSON.stringify(value)) : value).join(" ");
        for (const detail of ["RPC rejected", "onlyOwner", "inner revert", "execution reverted", "0x1234", "nested reason"]) assert.ok(output.includes(detail), detail);
    });
}
