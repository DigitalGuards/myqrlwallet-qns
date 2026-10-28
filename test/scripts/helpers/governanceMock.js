const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { keccak256, utf8ToHex, toChecksumAddress } = require("@theqrl/web3-utils");
const { loadSdk } = require("../../../scripts/lib/sdk");

const addr = (byte) => `Q${byte.repeat(64)}`;
const DEPLOYER = addr("aa");
const FINAL = addr("bb");
const CONTROLLER = addr("cc");
const OTHER = addr("dd");
const GENESIS = `0x${"12".repeat(32)}`;
const CONTRACTS = {
    QNSRegistry: addr("01"), Root: addr("02"), FIFSQRLRegistrar: addr("03"),
    ReverseRegistrar: addr("04"), QRLPublicResolver: addr("05"),
    QRLSignatureVerifier: addr("06"),
};
// Signature words are independent of the SDK ABI implementation under test.
const CONTROLLER_TOPIC = "0x4c97694570a07277810af7e5669ffd5f6a2d6b74b6e9a274b8b870fd5114cf87" + "0".repeat(64);
const NEW_OWNER_TOPIC = keccak256(utf8ToHex("NewOwner(bytes32,bytes32,address)")) + "0".repeat(64);
const ROOT_TOPIC = `0x${"0".repeat(128)}`;
const labelHash = (label) => keccak256(utf8ToHex(label));
const topLevelNode = (hash) => keccak256(`0x${"0".repeat(64)}${hash.slice(2)}`);

async function governanceMock({ complete = false } = {}) {
    const sdk = await loadSdk();
    const { abi } = sdk;
    const config = {
        network: "Governance fixture", chainId: 3151999, genesisHash: GENESIS,
        rpcUrl: "https://rpc.example.test", tld: "qrl", deploymentBlock: 2,
        deployer: DEPLOYER, contracts: { ...CONTRACTS },
        handoff: { finalOwner: toChecksumAddress(FINAL), rootControllers: [toChecksumAddress(CONTROLLER)], reverseOwner: "finalOwner", lockLabels: ["qrl", "reverse"] },
    };
    const state = {
        owners: { Root: complete ? FINAL : DEPLOYER, ReverseRegistrar: complete ? FINAL : DEPLOYER },
        nodes: { root: CONTRACTS.Root, qrl: CONTRACTS.FIFSQRLRegistrar,
            reverse: complete ? FINAL : DEPLOYER, "addr.reverse": CONTRACTS.ReverseRegistrar },
        controllers: { Root: { [DEPLOYER]: !complete, [CONTROLLER]: complete }, ReverseRegistrar: {} },
        locks: { qrl: complete, reverse: complete },
        trustedReverseRegistrar: CONTRACTS.ReverseRegistrar, defaultResolver: CONTRACTS.QRLPublicResolver,
        topLevelOwners: {},
        pointers: Object.fromEntries(["Root", "FIFSQRLRegistrar", "ReverseRegistrar", "QRLPublicResolver"].map((name) => [name, CONTRACTS.QNSRegistry])),
        baseNode: sdk.nodeToHex(sdk.namehash("qrl")),
        code: Object.fromEntries([...Object.values(CONTRACTS), FINAL, CONTROLLER, OTHER].map((address) => [address, "0x6000"])),
    };
    const writes = [];
    const calls = [];
    const logQueries = [];
    const logs = [];
    const nonceQueries = [];
    const nodes = Object.fromEntries(["", "qrl", "reverse", "addr.reverse"].map((name) => [sdk.nodeToHex(sdk.namehash(name)), name || "root"]));
    const labels = Object.fromEntries(["qrl", "reverse"].map((label) => [abi.hashText(label), label]));
    const nameOf = (to) => Object.keys(CONTRACTS).find((name) => CONTRACTS[name] === to);
    const methodOf = (data) => ["owner()", "owner(bytes32)", "controllers(address)", "locked(bytes32)",
        "trustedReverseRegistrar()", "defaultResolver()", "setController(address,bool)",
        "setSubnodeOwner(bytes32,address)", "setOwner(bytes32,address)", "qns()", "baseNode()",
        "lock(bytes32)", "transferOwnership(address)"].find((signature) => abi.selector(signature) === data.slice(0, 10));
    const word = (data, index = 0) => `0x${data.slice(10 + index * 128, 10 + (index + 1) * 128)}`;
    const hash = (data) => word(data).slice(0, 66);
    const encodeAddress = (value) => `0x${abi.addressWord(value)}`;
    const encodeBool = (value) => `0x${abi.uintWord(value ? 1n : 0n)}`;
    const fixture = { config, sdk, state, writes, calls, logs, logQueries, nonceQueries, failAt: null, estimates: 0,
        networkChecks: 0, genesisChecks: 0, onEstimate: null, onReceipt: null, applyWrites: true,
        head: 9n, headReads: 0, pendingNonce: null };
    fixture.controllerLog = (name, address, enabled, block = fixture.head) => {
        logs.push({ address: CONTRACTS[name], topics: [CONTROLLER_TOPIC, encodeAddress(address)],
            data: encodeBool(enabled), blockNumber: abi.toQuantity(BigInt(block)) });
    };
    fixture.setController = (name, address, enabled, block = fixture.head) => {
        state.controllers[name][address] = enabled;
        fixture.controllerLog(name, address, enabled, block);
    };
    fixture.addTopLevel = (label, owner, block = fixture.head) => {
        const hash = labelHash(label);
        const node = topLevelNode(hash);
        if (label in state.nodes) state.nodes[label] = owner;
        else state.topLevelOwners[node] = owner;
        logs.push({ address: CONTRACTS.QNSRegistry,
            topics: [NEW_OWNER_TOPIC, ROOT_TOPIC, hash + "0".repeat(64)],
            data: encodeAddress(owner), blockNumber: abi.toQuantity(BigInt(block)) });
        return hash;
    };
    fixture.controllerLog("Root", DEPLOYER, true, 2n);
    if (complete) {
        fixture.controllerLog("Root", DEPLOYER, false, 8n);
        fixture.controllerLog("Root", CONTROLLER, true, 8n);
    }
    fixture.addTopLevel("qrl", state.nodes.qrl, 2n);
    fixture.addTopLevel("reverse", state.nodes.reverse, 2n);
    fixture.getLogs = async (query) => logs.filter((log) =>
        sdk.canonicalAddress(log.address) === sdk.canonicalAddress(query.address) &&
        BigInt(log.blockNumber) >= BigInt(query.fromBlock) && BigInt(log.blockNumber) <= BigInt(query.toBlock) &&
        query.topics.every((topic, index) => topic === null || (Array.isArray(topic)
            ? topic.includes(log.topics[index]) : topic === log.topics[index])));
    fixture.web3 = { requestManager: {
        send: async ({ method, params }) => {
            if (method === "qrl_chainId") return abi.toQuantity(await fixture.web3.qrl.getChainId());
            if (method === "qrl_getBlockByNumber") return fixture.web3.qrl.getBlock(params[0]);
            if (method === "qrl_call") return fixture.web3.qrl.call(...params);
            if (method === "qrl_getCode") return fixture.web3.qrl.getCode(...params);
            assert.equal(method, "qrl_getLogs");
            assert.equal(params.length, 1);
            const [query] = params;
            // QRVM topics are 64-byte words: 0x plus 128 hex characters.
            assert.match(query.topics[0], /^0x[0-9a-f]{128}$/);
            logQueries.push(query);
            return fixture.getLogs(query);
        },
    }, qrl: {
        getChainId: async () => { fixture.networkChecks++; return 3151999n; },
        getBlock: async (block) => { assert.equal(block, "0x0"); fixture.genesisChecks++; return { hash: GENESIS }; },
        getBlockNumber: async () => { fixture.headReads++; return fixture.head; },
        getCode: async (address, block) => { assert.ok(BigInt(block) <= fixture.head); return state.code[address] ?? "0x"; },
        getTransactionCount: async (address, block) => {
            assert.equal(address, DEPLOYER);
            nonceQueries.push(block);
            return block === "pending" && fixture.pendingNonce !== null ? fixture.pendingNonce : BigInt(writes.length);
        },
        call: async ({ to, data }, block) => {
            assert.ok(block === "latest" || BigInt(block) <= fixture.head);
            const contract = nameOf(to);
            const method = methodOf(data);
            calls.push({ contract, method, data, block });
            switch (method) {
                case "owner(bytes32)": return encodeAddress(state.nodes[nodes[hash(data)]] ?? state.topLevelOwners[hash(data)] ?? abi.ZERO_ADDRESS);
                case "owner()": return encodeAddress(state.owners[contract]);
                case "controllers(address)": return encodeBool(state.controllers[contract][abi.decodeAddress(word(data))]);
                case "locked(bytes32)": return encodeBool(state.locks[labels[hash(data)]]);
                case "trustedReverseRegistrar()": return encodeAddress(state.trustedReverseRegistrar);
                case "defaultResolver()": return encodeAddress(state.defaultResolver);
                case "qns()": return encodeAddress(state.pointers[contract]);
                case "baseNode()": return `0x${abi.bytes32Word(state.baseNode)}`;
                default: throw new Error(`Unexpected read ${contract}.${method}`);
            }
        },
        estimateGas: async (tx) => { fixture.estimates++; fixture.onEstimate?.(methodOf(tx.data)); return 100000n; },
        sendTransaction: async (tx) => {
            if (fixture.failAt === writes.length) throw new Error("Simulated interruption");
            assert.equal(tx.from, DEPLOYER);
            assert.equal(tx.chainId, 3151999n);
            assert.equal(fixture.networkChecks, fixture.genesisChecks);
            assert.ok(fixture.networkChecks > writes.length);
            assert.equal(tx.gas, 120000n);
            const contract = nameOf(tx.to);
            const method = methodOf(tx.data);
            const address = abi.decodeAddress(word(tx.data, ["setSubnodeOwner(bytes32,address)", "setOwner(bytes32,address)"].includes(method) ? 1 : 0));
            fixture.head++;
            if (fixture.applyWrites) {
                if (method === "setSubnodeOwner(bytes32,address)") {
                    assert.ok(state.controllers.Root[DEPLOYER]);
                    assert.equal(state.locks[labels[hash(tx.data)]], false);
                    fixture.addTopLevel(labels[hash(tx.data)], address);
                } else if (method === "setOwner(bytes32,address)") {
                    assert.equal(contract, "QNSRegistry");
                    assert.equal(state.nodes[nodes[hash(tx.data)]], tx.from, "registry node owner only");
                    state.nodes[nodes[hash(tx.data)]] = address;
                } else {
                    assert.equal(state.owners[contract], DEPLOYER, "onlyOwner");
                    if (method === "setController(address,bool)") fixture.setController(contract, address, abi.decodeBool(word(tx.data, 1)));
                    else if (method === "lock(bytes32)") state.locks[labels[hash(tx.data)]] = true;
                    else if (method === "transferOwnership(address)") state.owners[contract] = address;
                    else throw new Error(`Unexpected write ${method}`);
                }
            }
            writes.push({ ...tx, contract, method });
            const receipt = { status: 1n, blockNumber: fixture.head, transactionHash: `0x${writes.length.toString(16).padStart(64, "0")}` };
            fixture.onReceipt?.(receipt);
            return receipt;
        },
    } };
    return fixture;
}

function loadCli(name, fixture, overrides = {}, { entry = false, argv = [], env = { QNS_CONFIG: "fixture.json" } } = {}) {
    const file = path.resolve(__dirname, "../../../scripts", name);
    const realRequire = createRequire(file);
    const processMock = { env, argv: ["node", file, ...argv] };
    const moduleMock = { exports: {} };
    const output = [];
    const errors = [];
    const requireMock = (dependency) => {
        if (dependency in overrides) return overrides[dependency];
        if (dependency === "@theqrl/web3") return { Web3: class { constructor() { return fixture.web3; } } };
        if (dependency === "./lib/governance") return { ...realRequire(dependency), loadGovernanceConfig: async (selector) => {
            fixture.configSelectors ??= [];
            fixture.configSelectors.push(selector);
            return fixture.config;
        } };
        if (dependency === "./lib/errors") return { printError: (prefix, error) => realRequire(dependency).printError(prefix, error, (...args) => errors.push(args)) };
        return realRequire(dependency);
    };
    if (entry) requireMock.main = moduleMock;
    vm.runInNewContext(fs.readFileSync(file, "utf8"), {
        require: requireMock,
        module: moduleMock, __dirname: path.dirname(file), process: processMock,
        console: { log: (line) => output.push(line), error: (...args) => errors.push(args) },
    }, { filename: file });
    return { ...moduleMock.exports, process: processMock, output, errors };
}

module.exports = { governanceMock, loadCli, DEPLOYER, FINAL, CONTROLLER, OTHER, CONTRACTS,
    CONTROLLER_TOPIC, NEW_OWNER_TOPIC, ROOT_TOPIC, labelHash };
