const test = require("node:test");
const assert = require("node:assert/strict");
const { keccak256, utf8ToHex } = require("@theqrl/web3-utils");
const { createScanCache, governancePolicy, readPowerState } = require("../../scripts/lib/governance");
const { runHandoff } = require("../../scripts/lib/handoff");
const { checkPowers } = require("../../scripts/lib/checkPowers");
const { governanceMock, DEPLOYER, OTHER, CONTRACTS, CONTROLLER_TOPIC, NEW_OWNER_TOPIC, ROOT_TOPIC, labelHash } = require("./helpers/governanceMock");

const preview = (fixture) => runHandoff({ ...fixture, log: () => {} });
const check = (fixture) => checkPowers({ ...fixture, log: () => {} });

test("event queries match independent native signatures and the root parent topic", async () => {
    const fixture = await governanceMock();
    await preview(fixture);
    const controllerTopic = "0x4c97694570a07277810af7e5669ffd5f6a2d6b74b6e9a274b8b870fd5114cf87" + "0".repeat(64);
    const ownerTopic = keccak256(utf8ToHex("NewOwner(bytes32,bytes32,address)")) + "0".repeat(64);
    assert.equal(CONTROLLER_TOPIC, controllerTopic);
    assert.equal(NEW_OWNER_TOPIC, ownerTopic);
    for (const query of fixture.logQueries) {
        assert.deepEqual(query.topics, query.address === CONTRACTS.QNSRegistry
            ? [ownerTopic, `0x${"0".repeat(128)}`] : [controllerTopic]);
    }
    assert.ok(fixture.logs.every((log) => /^0x[0-9a-f]+$/.test(log.blockNumber)));
});

test("mock log discovery filters address, every topic and block boundaries", async () => {
    const fixture = await governanceMock();
    fixture.setController("Root", OTHER, true, 4n);
    const query = { address: CONTRACTS.Root, topics: [CONTROLLER_TOPIC], fromBlock: "0x4", toBlock: "0x4" };
    assert.equal((await fixture.getLogs(query)).length, 1);
    for (const changed of [{ address: CONTRACTS.ReverseRegistrar }, { topics: [NEW_OWNER_TOPIC] },
        { topics: [CONTROLLER_TOPIC, ROOT_TOPIC] }, { fromBlock: "0x5", toBlock: "0x8" }, { fromBlock: "0x1", toBlock: "0x3" }]) {
        const result = await fixture.getLogs({ ...query, ...changed });
        assert.equal(result.some((log) => log.topics[1] === `0x${fixture.sdk.abi.addressWord(OTHER)}`), false);
    }
});

for (const kind of ["empty index", "wrong controller topic", "missing Root enable", "missing ReverseRegistrar enable", "late deployment block", "missing qrl", "missing reverse", "wrong NewOwner topic"]) {
    test(`both commands fail closed for ${kind}`, async () => {
        const fixture = await governanceMock();
        const mutateTopics = (signature) => {
            for (const log of fixture.logs) if (log.topics[0] === signature) log.topics[0] = ROOT_TOPIC;
        };
        if (kind === "empty index") fixture.logs.length = 0;
        if (kind === "wrong controller topic") mutateTopics(CONTROLLER_TOPIC);
        if (kind === "wrong NewOwner topic") mutateTopics(NEW_OWNER_TOPIC);
        if (kind === "missing Root enable") {
            fixture.logs.splice(fixture.logs.findIndex((log) => log.address === CONTRACTS.Root), 1);
            fixture.controllerLog("Root", DEPLOYER, false, 3n);
        }
        if (kind === "missing ReverseRegistrar enable") fixture.state.controllers.ReverseRegistrar[DEPLOYER] = true;
        if (kind === "late deployment block") fixture.config.deploymentBlock = 3;
        if (kind.startsWith("missing ") && ["qrl", "reverse"].includes(kind.slice(8))) {
            const topic = labelHash(kind.slice(8)) + "0".repeat(64);
            fixture.logs.splice(fixture.logs.findIndex((log) => log.topics[2] === topic), 1);
        }
        const expected = /controller|enable/.test(kind) ? /incomplete ControllerChanged history/ : /incomplete NewOwner history/;
        await assert.rejects(preview(fixture), expected);
        await assert.rejects(check(fixture), expected);
        assert.equal(fixture.writes.length, 0);
    });
}

test("enabled controller positive control identifies the contract and full address", async () => {
    const fixture = await governanceMock();
    fixture.logs.splice(0, 1);
    await assert.rejects(preview(fixture), { message: `incomplete ControllerChanged history for Root: enabled controller ${DEPLOYER} has no enabling log; use an RPC with complete logs and the registry deployment block` });
});

test("rejects right-aligned label topics and removed or out-of-range logs", async () => {
    for (const kind of ["alignment", "removed", "range"]) {
        const fixture = await governanceMock();
        const getLogs = fixture.getLogs;
        fixture.getLogs = async (query) => {
            const logs = structuredClone(await getLogs(query));
            if (query.address === CONTRACTS.QNSRegistry) {
                if (kind === "alignment") logs[0].topics[2] = `0x${"0".repeat(64)}${labelHash("qrl").slice(2)}`;
                if (kind === "removed") logs[0].removed = true;
                if (kind === "range") logs[0].blockNumber = "0x1";
            }
            return logs;
        };
        await assert.rejects(preview(fixture), /NewOwner topics|Removed|outside requested block range/);
    }
});

test("an unreviewed top-level label stops the handoff and fails the strict check", async () => {
    const fixture = await governanceMock();
    const hash = fixture.addTopLevel("dev", DEPLOYER);
    await assert.rejects(preview(fixture), /Unreviewed top-level label/);
    const report = await check(fixture);
    assert.equal(report.exitCode, 1);
    assert.ok(report.violations.some((v) => v.kind === "UNEXPECTED_TOP_LEVEL" && v.power === `registry.owner(${hash})`));
    assert.ok(report.rows.some((row) => row.power === "registry.owner(qrl)"));
    assert.equal(fixture.writes.length, 0);
});

test("reviewed top-level owners are checked against the current snapshot owner", async () => {
    const fixture = await governanceMock({ complete: true });
    const hash = fixture.addTopLevel("dev", OTHER);
    fixture.config.powerCheck = { topLevelOwners: { [hash]: OTHER } };
    assert.equal((await preview(fixture)).transactions.length, 0);
    assert.equal((await check(fixture)).exitCode, 0);
    fixture.addTopLevel("dev", DEPLOYER);
    await assert.rejects(preview(fixture), /Unreviewed top-level label/);
    assert.ok((await check(fixture)).violations.some((v) => v.power === `registry.owner(${hash})` && v.kind === "UNEXPECTED_HOLDER"));
});

test("a discovered top-level label with a zero owner holds no power", async () => {
    const fixture = await governanceMock({ complete: true });
    const hash = fixture.addTopLevel("dev", fixture.sdk.abi.ZERO_ADDRESS);
    assert.equal((await preview(fixture)).transactions.length, 0);
    const report = await check(fixture);
    assert.equal(report.exitCode, 0);
    assert.equal(report.rows.find((row) => row.power === `registry.owner(${hash})`).status, "OK");
});

test("top-level owner config validates label hashes and keeps built-in expectations fixed", async () => {
    const fixture = await governanceMock();
    for (const map of [[], "invalid", { dev: OTHER }, { [labelHash("qrl")]: OTHER }, { [labelHash("dev")]: "invalid" }]) {
        fixture.config.powerCheck = { topLevelOwners: map };
        await assert.rejects(preview(fixture));
    }
});

test("disabled Root and ReverseRegistrar candidates need no expectation", async () => {
    const fixture = await governanceMock();
    delete fixture.config.handoff;
    fixture.controllerLog("Root", OTHER, false);
    fixture.controllerLog("ReverseRegistrar", OTHER, false);
    const report = await check(fixture);
    for (const contract of ["Root", "ReverseRegistrar"]) {
        const row = report.rows.find((entry) => entry.power === `${contract}.controllers(${OTHER})`);
        assert.equal(row.status, "OK");
    }
});

test("one execution scan cache queries only newly mined blocks after its initial history", async () => {
    const fixture = await governanceMock();
    const reviewed = await preview(fixture);
    fixture.logQueries.length = 0;
    await runHandoff({ ...fixture, dryRun: false, executeHash: reviewed.hash, account: { address: DEPLOYER }, log: () => {} });
    for (const address of [CONTRACTS.Root, CONTRACTS.ReverseRegistrar, CONTRACTS.QNSRegistry]) {
        const queries = fixture.logQueries.filter((query) => query.address === address);
        assert.deepEqual(queries.map((query) => [query.fromBlock, query.toBlock]), [
            ["0x2", "0x9"], ...Array.from({ length: 7 }, (_, index) => {
                const block = `0x${(index + 10).toString(16)}`;
                return [block, block];
            }),
        ]);
    }
});

test("range halving covers every block without gaps and caches candidates, enables and labels", async () => {
    const fixture = await governanceMock({ complete: true });
    fixture.head = 4103n;
    const successful = [];
    const getLogs = fixture.getLogs;
    fixture.getLogs = async (query) => {
        if (BigInt(query.toBlock) - BigInt(query.fromBlock) + 1n > 127n) throw new Error("block range exceeds maximum");
        successful.push(query);
        return getLogs(query);
    };
    const policy = governancePolicy(fixture.config, fixture.sdk);
    const cache = createScanCache();
    const read = () => readPowerState(fixture.web3, policy, fixture.sdk, { cache });
    await read();
    const count = fixture.logQueries.length;
    await read();
    assert.equal(fixture.logQueries.length, count);
    fixture.head = 4108n;
    fixture.setController("Root", OTHER, true);
    const label = fixture.addTopLevel("dev", OTHER);
    const next = await read();
    assert.equal(next.controllers.Root[OTHER], true);
    assert.equal(next.topLevelOwners[label], OTHER);
    assert.ok(cache.enabling.Root.has(DEPLOYER));
    for (const address of [CONTRACTS.Root, CONTRACTS.ReverseRegistrar, CONTRACTS.QNSRegistry]) {
        let nextBlock = 2n;
        for (const query of successful.filter((query) => query.address === address)) {
            assert.equal(BigInt(query.fromBlock), nextBlock);
            assert.ok(BigInt(query.toBlock) - BigInt(query.fromBlock) < 127n);
            nextBlock = BigInt(query.toBlock) + 1n;
        }
        assert.equal(nextBlock, fixture.head + 1n);
    }
});
