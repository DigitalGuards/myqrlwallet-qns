const test = require("node:test");
const assert = require("node:assert/strict");
const { checkPowers } = require("../../scripts/lib/checkPowers");
const { governanceMock, loadCli, DEPLOYER, FINAL, CONTROLLER, OTHER, CONTRACTS } = require("./helpers/governanceMock");

const check = (fixture, options = {}) => checkPowers({ ...fixture, log: () => {}, ...options });
const has = (report, power, kind) => report.violations.some((violation) => violation.power === power && violation.kind === kind);

test("reports every requested power, full addresses, locks and trust at one block", async () => {
    const fixture = await governanceMock({ complete: true });
    const output = [];
    const report = await check(fixture, { log: (line) => output.push(line) });
    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.violations, []);
    for (const power of ["Root.owner", "ReverseRegistrar.owner", "registry.owner(root)", "registry.owner(qrl)",
        "registry.owner(reverse)", "registry.owner(addr.reverse)", "Root.locked(qrl)", "Root.locked(reverse)",
        "resolver.trustedReverseRegistrar", "trusted registrar == addr.reverse owner"]) {
        assert.ok(report.rows.some((row) => row.power === power), power);
    }
    assert.ok(report.rows.some((row) => row.power === `Root.controllers(${CONTROLLER})` && row.observed === "true"));
    assert.ok(report.rows.some((row) => row.power === `ReverseRegistrar.controllers(${DEPLOYER})` && row.observed === "false"));
    assert.match(output.join("\n"), /Power \| Observed \| Expected \| Code \| Status/);
    assert.ok(output.join("\n").includes(FINAL));
    assert.ok(fixture.calls.every((call) => call.block === "0x9"));
    assert.ok(fixture.logQueries.every((query) => query.fromBlock === "0x2" && query.toBlock === "0x9" && query.topics[0].length === 130));
    assert.equal(fixture.writes.length, 0);
    assert.equal(fixture.estimates, 0);
});

const authorityCases = [
    ["Root.owner", (f, holder) => { f.state.owners.Root = holder; }],
    ["ReverseRegistrar.owner", (f, holder) => { f.state.owners.ReverseRegistrar = holder; }],
    ...["root", "qrl", "reverse", "addr.reverse"].map((node) => [`registry.owner(${node})`, (f, holder) => { f.state.nodes[node] = holder; }]),
    ["resolver.trustedReverseRegistrar", (f, holder) => { f.state.trustedReverseRegistrar = holder; }],
    ["ReverseRegistrar.defaultResolver", (f, holder) => { f.state.defaultResolver = holder; }],
];

for (const [power, assign] of authorityCases) {
    test(`rejects an account without code holding ${power}`, async () => {
        const fixture = await governanceMock({ complete: true });
        assign(fixture, DEPLOYER);
        const report = await check(fixture);
        assert.equal(report.exitCode, 1);
        assert.ok(has(report, power, "NO_CODE"));
    });
    test(`rejects an unexpected contract holding ${power}`, async () => {
        const fixture = await governanceMock({ complete: true });
        assign(fixture, OTHER);
        const report = await check(fixture);
        assert.equal(report.exitCode, 1);
        assert.ok(has(report, power, "UNEXPECTED_HOLDER"));
        assert.equal(has(report, power, "NO_CODE"), false);
    });
}

for (const name of ["Root", "ReverseRegistrar"]) {
    test(`discovers unexpected ${name} controllers through events and checks their code`, async () => {
        const fixture = await governanceMock({ complete: true });
        fixture.state.controllers[name][OTHER] = true;
        fixture.state.controllers[name][DEPLOYER] = true;
        const report = await check(fixture);
        assert.equal(report.exitCode, 1);
        assert.ok(has(report, `${name}.controllers(${OTHER})`, "UNEXPECTED_HOLDER"));
        assert.ok(has(report, `${name}.controllers(${DEPLOYER})`, "NO_CODE"));
        assert.ok(has(report, `${name}.controllers(${DEPLOYER})`, "UNEXPECTED_HOLDER"));
    });
    test(`rejects a missing expected ${name} controller`, async () => {
        const fixture = await governanceMock({ complete: true });
        if (name === "ReverseRegistrar") fixture.config.powerCheck = { reverseControllers: [CONTROLLER] };
        fixture.state.controllers[name][CONTROLLER] = false;
        const report = await check(fixture);
        assert.ok(has(report, `${name}.controllers(${CONTROLLER})`, "MISSING_CONTROLLER"));
        assert.equal(report.exitCode, 1);
    });
}

test("a configured final owner with no code still fails", async () => {
    const fixture = await governanceMock({ complete: true });
    delete fixture.state.code[FINAL];
    const report = await check(fixture);
    assert.ok(has(report, "Root.owner", "NO_CODE"));
    assert.equal(has(report, "Root.owner", "UNEXPECTED_HOLDER"), false);
    assert.equal(report.exitCode, 1);
});

test("a reviewed controller with no code still fails", async () => {
    const fixture = await governanceMock({ complete: true });
    delete fixture.state.code[CONTROLLER];
    const report = await check(fixture);
    assert.ok(has(report, `Root.controllers(${CONTROLLER})`, "NO_CODE"));
    assert.equal(has(report, `Root.controllers(${CONTROLLER})`, "UNEXPECTED_HOLDER"), false);
});

for (const label of ["qrl", "reverse"]) {
    test(`rejects unexpected ${label} lock state in both directions`, async () => {
        const fixture = await governanceMock({ complete: true });
        fixture.state.locks[label] = false;
        assert.ok(has(await check(fixture), `Root.locked(${label})`, "LOCK_MISMATCH"));
        fixture.state.locks[label] = true;
        fixture.config.handoff.lockLabels = fixture.config.handoff.lockLabels.filter((entry) => entry !== label);
        assert.ok(has(await check(fixture), `Root.locked(${label})`, "LOCK_MISMATCH"));
    });
}

test("rejects the trusted registrar mismatch and a renounced owner", async () => {
    const fixture = await governanceMock({ complete: true });
    fixture.state.trustedReverseRegistrar = OTHER;
    fixture.state.owners.Root = `Q${"00".repeat(64)}`;
    const report = await check(fixture);
    assert.ok(has(report, "trusted registrar == addr.reverse owner", "TRUST_MISMATCH"));
    assert.ok(has(report, "Root.owner", "NO_CODE"));
    assert.ok(has(report, "Root.owner", "UNEXPECTED_HOLDER"));
});

test("report-only preserves every alpha violation while returning zero", async () => {
    const fixture = await governanceMock();
    delete fixture.config.handoff;
    const enforced = await check(fixture);
    assert.equal(enforced.exitCode, 1);
    assert.ok(has(enforced, "Root.owner", "MISSING_EXPECTATION"));
    assert.ok(has(enforced, "registry.owner(reverse)", "NO_CODE"));
    const report = await check(fixture, { reportOnly: true });
    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.violations, enforced.violations);
    assert.equal(fixture.writes.length, 0);
});

test("explicit list mode probes configured candidates and announces its coverage limit", async () => {
    const fixture = await governanceMock({ complete: true });
    fixture.config.powerCheck = { controllerMode: "list", controllerCandidates: { Root: [OTHER], ReverseRegistrar: [] } };
    fixture.state.controllers.Root[OTHER] = true;
    const report = await check(fixture);
    assert.ok(has(report, `Root.controllers(${OTHER})`, "UNEXPECTED_HOLDER"));
    assert.match(report.state.coverage, /unlisted controllers may exist/);
    assert.equal(fixture.logQueries.length, 0);
    delete fixture.config.powerCheck.controllerCandidates.ReverseRegistrar;
    await assert.rejects(check(fixture), /explicit address array/);
});

test("event history discovers revoked controllers but mapping reads determine current power", async () => {
    const fixture = await governanceMock({ complete: true });
    const getLogs = fixture.getLogs;
    fixture.getLogs = async (query) => [...await getLogs(query), {
        address: query.address,
        topics: [query.topics[0], `0x${fixture.sdk.abi.addressWord(OTHER)}`],
        data: `0x${fixture.sdk.abi.uintWord(1n)}`,
    }];
    const report = await check(fixture);
    assert.equal(report.exitCode, 0);
    assert.ok(report.rows.some((row) => row.power === `Root.controllers(${OTHER})` && row.observed === "false"));
});

for (const failure of ["logs", "call", "code", "malformed code", "malformed logs", "chain", "genesis"]) {
    test(`fails closed for ${failure}, including report-only`, async () => {
        const fixture = await governanceMock({ complete: true });
        if (failure === "logs") fixture.getLogs = async () => { throw new Error("RPC logs unavailable"); };
        if (failure === "call") fixture.web3.qrl.call = async () => "0x";
        if (failure === "code") fixture.web3.qrl.getCode = async () => { throw new Error("RPC code unavailable"); };
        if (failure === "malformed code") fixture.web3.qrl.getCode = async () => "0xgg";
        if (failure === "malformed logs") fixture.getLogs = async () => [{ address: CONTRACTS.Root, topics: [] }];
        if (failure === "chain") fixture.web3.qrl.getChainId = async () => 1n;
        if (failure === "genesis") fixture.web3.qrl.getBlock = async () => ({ hash: `0x${"00".repeat(32)}` });
        await assert.rejects(check(fixture, { reportOnly: true }));
        assert.equal(fixture.writes.length, 0);
    });
}

test("controller log scans page down when an RPC enforces a smaller block range", async () => {
    const fixture = await governanceMock({ complete: true });
    const getLogs = fixture.getLogs;
    fixture.getLogs = async (query) => {
        if (BigInt(query.toBlock) - BigInt(query.fromBlock) > 1n) throw new Error("block range exceeds limit");
        return getLogs(query);
    };
    const report = await check(fixture);
    assert.equal(report.exitCode, 0);
    assert.equal(fixture.logQueries[0].fromBlock, "0x2");
    assert.equal(fixture.logQueries.at(-1).toBlock, "0x9");
});

test("power-check CLI sets nonzero status for alpha violations and zero for report-only", async () => {
    const fixture = await governanceMock();
    const cli = loadCli("check-powers.js", fixture, {
        "./lib/checkPowers": { checkPowers: (options) => checkPowers({ ...options, log: () => {} }) },
    });
    await cli.main([]);
    assert.equal(cli.process.exitCode, 1);
    await cli.main(["--report-only"]);
    assert.equal(cli.process.exitCode, 0);
    assert.equal(fixture.writes.length, 0);
    await assert.rejects(cli.main(["--reportonly"]), /Usage/);
});
