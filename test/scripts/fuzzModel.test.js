// Unit tests for the stateful fuzzer's codec, fixed world, reference model and
// generator. They need no compiler or VM, so CI runs them; the differential
// runs themselves (npm run fuzz) need the local toolchain.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const abi = require("../../scripts/lib/fuzz/abi64");
const W = require("../../scripts/lib/fuzz/world");
const { EVENT_TOPICS, encodeFunction, errorData, revertString } = require("../../scripts/lib/fuzz/interface");
const { MUTATIONS, applyStep, setMutation, viewOutput } = require("../../scripts/lib/fuzz/model");
const { OBSERVATIONS, digestOf, expectedOutputs } = require("../../scripts/lib/fuzz/observe");
const { createRandom, generateSequence, sequenceSeed } = require("../../scripts/lib/fuzz/generator");
const { PROFILES, modelSetup, parseArguments } = require("../../scripts/fuzz-qns");

const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "sdk", "src", "fixtures", "qns-vectors.json"), "utf8")
);
const strip = (value) => value.replace(/^0x/, "");
const { ACTORS, CONTRACTS, NODES, LABELS, ZERO } = W;
const run = (state, actor, contract, fn, args) => applyStep(state, { actor, contract, fn, args });

test("the 64-byte ABI codec places every type in a 64-byte word", () => {
    const encoded = abi.encode(
        ["address", "bytes32", "uint64", "bool", "string"],
        [ACTORS.alice, "11".repeat(32), 300n, true, "qns"]
    );
    assert.equal(encoded.length, 64 * 7);
    assert.equal(abi.hex(encoded.subarray(64, 128)), "11".repeat(32) + "00".repeat(32));
    assert.equal(encoded.readUInt16BE(128 + 62), 300);
    assert.equal(abi.hex(encoded.subarray(256, 320)).replace(/^0+/, ""), (5 * 64).toString(16));
    assert.deepEqual(abi.decode(["address", "bytes32", "uint64", "bool", "string"], encoded), [
        `Q${ACTORS.alice}`,
        `0x${"11".repeat(32)}`,
        300n,
        true,
        "qns",
    ]);
    assert.equal(abi.hex(abi.selector("setOwner(bytes32,address)")), "5b0fc9c3");
    assert.throws(() => abi.decode(["bool"], Buffer.alloc(65)), /unexpected bytes/);
});

test("the fixed world reproduces the SDK known answers", () => {
    assert.equal(W.namehash("addr.reverse"), strip(fixture.namehash["addr.reverse"]));
    assert.equal(W.namehash("alice.qrl"), strip(fixture.namehash["alice.qrl"]));
    assert.equal(W.ADDR_REVERSE_NODE, strip(fixture.namehash["addr.reverse"]));
    const address = fixture.reverse.address.replace(/^Q/, "");
    assert.equal(W.reverseLabel(address), strip(fixture.reverse.sha3HexAddress));
    assert.equal(W.reverseNode(address), strip(fixture.reverse.node));
});

test("actor twins differ only in their high bytes", () => {
    assert.equal(ACTORS.alice.slice(2), ACTORS.aliceHigh.slice(2));
    assert.notEqual(ACTORS.alice, ACTORS.aliceHigh);
    assert.equal(ACTORS.bob.slice(64), ACTORS.bobHigh.slice(64));
    assert.equal(ACTORS.carol.slice(88), ACTORS.carolHigh.slice(88));
    assert.equal(new Set(Object.values(ACTORS)).size, Object.keys(ACTORS).length);
    assert.notEqual(W.reverseNode(ACTORS.alice), W.reverseNode(ACTORS.aliceHigh));
});

test("CREATE addresses follow the hyptest host derivation", () => {
    assert.equal(
        CONTRACTS.registry,
        "00".repeat(32) + "82b8d4df44d75ed648ea21847699cf980ed3905a7a2417f1b6a39c5951cacad1"
    );
    assert.equal(W.createAddress(ACTORS.admin, 1), CONTRACTS.registry);
    assert.equal(new Set(Object.values(CONTRACTS)).size, 6);
});

test("the model replays the production deployment", () => {
    const { state, results } = modelSetup();
    assert.ok(results.every((result) => result.status === "success"));
    assert.equal(viewOutput(state, "registry", "owner", [W.ZERO_NODE]).toString("hex"), CONTRACTS.root);
    assert.equal(viewOutput(state, "registry", "owner", [NODES.qrl]).toString("hex"), CONTRACTS.fifs);
    assert.equal(viewOutput(state, "registry", "owner", [NODES.addrReverse]).toString("hex"), CONTRACTS.rr);
    assert.equal(viewOutput(state, "rr", "defaultResolver", []).toString("hex"), CONTRACTS.resolver);
    assert.equal(expectedOutputs(state).length, OBSERVATIONS.length);
    assert.match(digestOf(expectedOutputs(state)), /^[0-9a-f]{64}$/);
});

test("registry operators may write the registry and never the resolver", () => {
    let { state } = modelSetup();
    ({ state } = run(state, "alice", "fifs", "register", [LABELS.alice, ACTORS.alice]));
    ({ state } = run(state, "alice", "registry", "setApprovalForAll", [ACTORS.bob, true]));
    assert.equal(run(state, "bob", "resolver", "setAddr", [NODES.alice, ACTORS.bob]).result.status, "revert");
    assert.equal(run(state, "bobHigh", "registry", "setResolver", [NODES.alice, CONTRACTS.resolver]).result.status, "revert");
    const write = run(state, "bob", "registry", "setResolver", [NODES.alice, CONTRACTS.resolver]);
    assert.equal(write.result.status, "success");
    assert.deepEqual(write.result.logs[0].topics, [EVENT_TOPICS.NewResolver, abi.leftWord(Buffer.from(NODES.alice, "hex"))]);
});

test("revert data matches the contract errors", () => {
    let { state } = modelSetup();
    ({ state } = run(state, "alice", "fifs", "register", [LABELS.alice, ACTORS.alice]));
    assert.deepEqual(
        run(state, "bob", "fifs", "register", [LABELS.alice, ACTORS.bob]).result.output,
        errorData("NotAvailable(bytes32,address)", ["bytes32", "address"], [LABELS.alice, ACTORS.alice])
    );
    assert.deepEqual(
        run(state, "bob", "resolver", "setName", [NODES.alice, "x"]).result.output,
        errorData("NotAuthorised(bytes32,address)", ["bytes32", "address"], [NODES.alice, ACTORS.bob])
    );
    assert.deepEqual(
        run(state, "bob", "root", "lock", [LABELS.qrl]).result.output,
        errorData("OwnableUnauthorizedAccount(address)", ["address"], [ACTORS.bob])
    );
    assert.deepEqual(
        run(state, "bob", "root", "setSubnodeOwner", [LABELS.qrl, ACTORS.bob]).result.output,
        revertString("Controllable: Caller is not a controller")
    );
    // An unauthorised reverse claim for an address without code reverts with
    // empty data; for a contract without owner() it reverts with the reason.
    assert.equal(run(state, "bob", "rr", "claimForAddr", [ACTORS.alice, ACTORS.bob, ZERO]).result.output.length, 0);
    assert.deepEqual(
        run(state, "bob", "rr", "claimForAddr", [CONTRACTS.registry, ACTORS.bob, ZERO]).result.output,
        revertString("ReverseRegistrar: Caller is not a controller or authorised by address or the address itself")
    );
});

test("a reverse name claims, sets the default resolver and writes through the trusted registrar", () => {
    const { state } = modelSetup();
    const { result } = run(state, "carol", "rr", "setName", ["carol.qrl"]);
    const node = W.reverseNode(ACTORS.carol);
    assert.equal(result.status, "success");
    assert.equal(abi.hex(result.output), node + "00".repeat(32));
    assert.deepEqual(
        result.logs.map((log) => [log.address, log.topics[0]]),
        [
            [CONTRACTS.rr, EVENT_TOPICS.ReverseClaimed],
            [CONTRACTS.registry, EVENT_TOPICS.NewOwner],
            [CONTRACTS.registry, EVENT_TOPICS.NewResolver],
            [CONTRACTS.resolver, EVENT_TOPICS.NameChanged],
        ]
    );
    assert.equal(run(state, "carol", "rr", "setNameForAddr", [ACTORS.carol, ACTORS.carol, CONTRACTS.registry, "x"]).result.status, "revert");
});

test("the generator is deterministic per seed and reaches every operation", () => {
    const { state } = modelSetup();
    const a = generateSequence(sequenceSeed("unit", 7), 30, state);
    const b = generateSequence(sequenceSeed("unit", 7), 30, state);
    const c = generateSequence(sequenceSeed("unit", 8), 30, state);
    assert.deepEqual(a.steps, b.steps);
    assert.notDeepEqual(a.steps, c.steps);
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
        for (const step of generateSequence(sequenceSeed("coverage", i), 25, state).steps) {
            seen.add(`${step.contract}.${step.fn}`);
        }
    }
    const random = createRandom(1);
    assert.ok(random.next() !== random.next());
    for (const operation of [
        "registry.setOwner",
        "registry.setSubnodeRecord",
        "registry.setApprovalForAll",
        "root.renounceOwnership",
        "rr.setNameForAddr",
        "rr.transferOwnership",
        "fifs.register",
        "resolver.clearRecords",
    ]) {
        assert.ok(seen.has(operation), operation);
    }
    assert.equal(seen.size, 28);
});

test("planted mutations change the model and are restored", () => {
    const { state } = modelSetup();
    const step = { actor: "alice", contract: "rr", fn: "claim", args: [ACTORS.alice] };
    const honest = applyStep(state, step).result;
    setMutation("reverse-label-20-bytes");
    try {
        assert.notDeepEqual(applyStep(state, step).result.output, honest.output);
    } finally {
        setMutation(null);
    }
    assert.deepEqual(applyStep(state, step).result.output, honest.output);
    assert.ok(Object.keys(MUTATIONS).length >= 8);
    assert.throws(() => setMutation("no-such-mutation"), /unknown model mutation/);
});

test("fuzz options follow flags, then environment, then profile", () => {
    const argv = (...flags) => ["node", "fuzz-qns.js", ...flags];
    assert.equal(parseArguments(argv(), {}).sequences, PROFILES.ci.sequences);
    assert.equal(parseArguments(argv("--profile", "long"), {}).sequences, 20000);
    assert.equal(parseArguments(argv("--profile", "long"), { QNS_FUZZ_SEQUENCES: "50" }).sequences, 50);
    assert.equal(parseArguments(argv("--profile", "long", "--sequences", "7"), { QNS_FUZZ_SEQUENCES: "50" }).sequences, 7);
    assert.deepEqual(parseArguments(argv("--modes", "all"), {}).modes.length, 4);
    assert.throws(() => parseArguments(argv("--modes", "solc"), {}), /unknown codegen mode/);
    assert.throws(() => parseArguments(argv("--sequences", "0"), {}), /positive integer/);
    assert.ok(PROFILES.long.sequences >= 20000);
});

test("encodeFunction rejects unknown functions", () => {
    assert.throws(() => encodeFunction("registry", "selfdestruct", []), /unknown function/);
    assert.equal(encodeFunction("rr", "setName", ["x"]).length, 4 + 64 * 3);
});
