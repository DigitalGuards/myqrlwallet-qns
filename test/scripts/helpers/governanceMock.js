const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
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
};

async function governanceMock({ complete = false } = {}) {
    const sdk = await loadSdk();
    const { abi } = sdk;
    const config = {
        network: "Governance fixture", chainId: 3151999, genesisHash: GENESIS,
        rpcUrl: "https://rpc.example.test", tld: "qrl", deploymentBlock: 2,
        deployer: DEPLOYER, contracts: { ...CONTRACTS },
        handoff: { finalOwner: FINAL, rootControllers: [CONTROLLER], reverseOwner: "finalOwner", lockLabels: ["qrl", "reverse"] },
    };
    const state = {
        owners: { Root: complete ? FINAL : DEPLOYER, ReverseRegistrar: complete ? FINAL : DEPLOYER },
        nodes: { root: CONTRACTS.Root, qrl: CONTRACTS.FIFSQRLRegistrar,
            reverse: complete ? FINAL : DEPLOYER, "addr.reverse": CONTRACTS.ReverseRegistrar },
        controllers: { Root: { [DEPLOYER]: !complete, [CONTROLLER]: complete }, ReverseRegistrar: {} },
        locks: { qrl: complete, reverse: complete },
        trustedReverseRegistrar: CONTRACTS.ReverseRegistrar, defaultResolver: CONTRACTS.QRLPublicResolver,
        code: Object.fromEntries([...Object.values(CONTRACTS), FINAL, CONTROLLER, OTHER].map((address) => [address, "0x6000"])),
    };
    const writes = [];
    const calls = [];
    const logQueries = [];
    const nodes = Object.fromEntries(["", "qrl", "reverse", "addr.reverse"].map((name) => [sdk.nodeToHex(sdk.namehash(name)), name || "root"]));
    const labels = Object.fromEntries(["qrl", "reverse"].map((label) => [abi.hashText(label), label]));
    const nameOf = (to) => Object.keys(CONTRACTS).find((name) => CONTRACTS[name] === to);
    const methodOf = (data) => ["owner()", "owner(bytes32)", "controllers(address)", "locked(bytes32)",
        "trustedReverseRegistrar()", "defaultResolver()", "setController(address,bool)",
        "setSubnodeOwner(bytes32,address)", "lock(bytes32)", "transferOwnership(address)"].find((signature) => abi.selector(signature) === data.slice(0, 10));
    const word = (data, index = 0) => `0x${data.slice(10 + index * 128, 10 + (index + 1) * 128)}`;
    const hash = (data) => word(data).slice(0, 66);
    const encodeAddress = (value) => `0x${abi.addressWord(value)}`;
    const encodeBool = (value) => `0x${abi.uintWord(value ? 1n : 0n)}`;
    const fixture = { config, sdk, state, writes, calls, logQueries, failAt: null, estimates: 0,
        networkChecks: 0, genesisChecks: 0, onEstimate: null, applyWrites: true };
    fixture.getLogs = async (query) => {
        const name = nameOf(query.address);
        return Object.entries(state.controllers[name]).map(([address, enabled]) => ({
            address: query.address, topics: [query.topics[0], encodeAddress(address)], data: encodeBool(enabled),
        }));
    };
    fixture.web3 = { requestManager: {
        send: async ({ method, params }) => {
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
        getBlockNumber: async () => 9n,
        getCode: async (address, block) => { assert.equal(block, "0x9"); return state.code[address] ?? "0x"; },
        call: async ({ to, data }, block) => {
            assert.ok(["0x9", "latest"].includes(block));
            const contract = nameOf(to);
            const method = methodOf(data);
            calls.push({ contract, method, data, block });
            switch (method) {
                case "owner(bytes32)": return encodeAddress(state.nodes[nodes[hash(data)]]);
                case "owner()": return encodeAddress(state.owners[contract]);
                case "controllers(address)": return encodeBool(state.controllers[contract][abi.decodeAddress(word(data))]);
                case "locked(bytes32)": return encodeBool(state.locks[labels[hash(data)]]);
                case "trustedReverseRegistrar()": return encodeAddress(state.trustedReverseRegistrar);
                case "defaultResolver()": return encodeAddress(state.defaultResolver);
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
            const address = abi.decodeAddress(word(tx.data, method === "setSubnodeOwner(bytes32,address)" ? 1 : 0));
            if (fixture.applyWrites) {
                if (method === "setSubnodeOwner(bytes32,address)") {
                    assert.ok(state.controllers.Root[DEPLOYER]);
                    assert.equal(state.locks[labels[hash(tx.data)]], false);
                    state.nodes[labels[hash(tx.data)]] = address;
                } else {
                    assert.equal(state.owners[contract], DEPLOYER, "onlyOwner");
                    if (method === "setController(address,bool)") state.controllers[contract][address] = abi.decodeBool(word(tx.data, 1));
                    else if (method === "lock(bytes32)") state.locks[labels[hash(tx.data)]] = true;
                    else if (method === "transferOwnership(address)") state.owners[contract] = address;
                    else throw new Error(`Unexpected write ${method}`);
                }
            }
            writes.push({ ...tx, contract, method });
            return { status: 1n, transactionHash: `0x${writes.length.toString(16).padStart(64, "0")}` };
        },
    } };
    return fixture;
}

function loadCli(name, fixture, overrides = {}) {
    const file = path.resolve(__dirname, "../../../scripts", name);
    const realRequire = createRequire(file);
    const processMock = { env: { QNS_CONFIG: "fixture.json" } };
    const moduleMock = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, "utf8"), {
        require: (dependency) => {
            if (dependency in overrides) return overrides[dependency];
            if (dependency === "@theqrl/web3") return { Web3: class { constructor() { return fixture.web3; } } };
            if (dependency === "./lib/governance") return { ...realRequire(dependency), loadGovernanceConfig: async () => fixture.config };
            return realRequire(dependency);
        },
        module: moduleMock, __dirname: path.dirname(file), process: processMock,
        console: { log() {}, error() {} },
    }, { filename: file });
    return { main: moduleMock.exports.main, process: processMock };
}

module.exports = { governanceMock, loadCli, DEPLOYER, FINAL, CONTROLLER, OTHER, CONTRACTS };
