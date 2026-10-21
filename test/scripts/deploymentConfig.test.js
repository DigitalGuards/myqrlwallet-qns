const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { loadDeploymentConfig } = require("../../scripts/lib/deploymentConfig");

test("requires an existing explicit config and preserves existing deployments", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qns-config-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "testnet-v3.json");
    await assert.rejects(async () => loadDeploymentConfig(file), /Create the requested deployment configuration first/);
    assert.equal(fs.existsSync(file), false);
    fs.copyFileSync(path.resolve(__dirname, "../../config/testnet-v3.example.json"), file);
    const config = await loadDeploymentConfig(file);
    assert.equal(config.chainId, 3151909);
    assert.equal(config.genesisHash, "0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4");
    assert.equal(Object.keys(config.contracts).length, 6);
    assert.ok(Object.values(config.contracts).every((value) => value === null));
    config.contracts.QNSRegistry = `Q${"1".repeat(128)}`;
    fs.writeFileSync(file, JSON.stringify(config));
    const original = fs.readFileSync(file, "utf8");
    await assert.rejects(async () => loadDeploymentConfig(file), /already has deployed/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    await assert.rejects(async () => loadDeploymentConfig(path.join(directory, "testnet-v3.example.json")), /ignored deployment/);
});

test("deploys all six contracts, wires forward and reverse, and writes app config using a mocked network", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qns-deploy-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "testnet-v3.json");
    fs.copyFileSync(path.resolve(__dirname, "../../config/testnet-v3.example.json"), file);
    const sourceFile = path.resolve(__dirname, "../../scripts/deploy-testnet.js");
    const realRequire = createRequire(sourceFile);
    const names = ["QNSRegistry", "Root", "FIFSQRLRegistrar", "ReverseRegistrar", "QRLPublicResolver", "QRLSignatureVerifier"];
    const writes = [];
    const deployments = [];
    let checks = 0;
    let loadedEnvironment = false;
    const account = { address: `Q${"a".repeat(128)}` };
    class Contract {
        constructor(abi) {
            this.name = abi[0].contractName;
            this.options = { address: `Q${String(names.indexOf(this.name) + 1).repeat(128)}` };
            this.methods = new Proxy({}, {
                get: (_, method) => (...args) => ({
                    estimateGas: async () => 100000n,
                    send: async (tx) => {
                        assert.equal(tx.from, account.address);
                        assert.equal(tx.chainId, 3151909n);
                        writes.push({ contract: this.name, method, args });
                        return { transactionHash: `0x${"f".repeat(64)}` };
                    },
                }),
            });
        }
        deploy(options) {
            return {
                estimateGas: async () => 1000000n,
                send: (tx) => {
                    assert.equal(tx.chainId, 3151909n);
                    deployments.push({ name: this.name, args: options.arguments });
                    return Object.assign(Promise.resolve(this), {
                        once(event, handler) {
                            assert.equal(event, "receipt");
                            handler({ blockNumber: 42n });
                        },
                    });
                },
            };
        }
    }
    class Web3 {
        constructor() {
            this.qrl = { Contract, getBalance: async () => 100000000000n, getBlockNumber: async () => 7n };
            this.utils = { keccak256: realRequire("@theqrl/web3").Web3.utils.keccak256, fromPlanck: () => "100" };
        }
    }
    const moduleMock = { exports: {} };
    const mockedRequire = (name) => {
        if (name === "fs") return {
            ...fs,
            existsSync: (filePath) => filePath.includes("build/hyperion") || fs.existsSync(filePath),
            readFileSync: (filePath, encoding) => {
                if (filePath.endsWith(".abi")) return JSON.stringify([{ contractName: path.basename(filePath, ".abi") }]);
                if (filePath.endsWith(".bin")) return "60006000";
                return fs.readFileSync(filePath, encoding);
            },
        };
        if (name === "dotenv") return { config() {} };
        if (name === "@theqrl/web3") return { Web3 };
        if (name === "./lib/hyperionArtifacts") return {
            sha256File: () => "fixture-manifest-hash",
            validateDeploymentTarget: realRequire(name).validateDeploymentTarget,
            verifyArtifactManifest: () => ({ contracts: names.map((contractName) => ({ contractName })), target: { name: "qrl2" }, compiler: { version: "mocked" } }),
        };
        if (name === "./lib/loadDeployer") return { loadDeployerFromEnvironment: (_, options) => { assert.equal(options.chainId, 3151909n); loadedEnvironment = true; return account; } };
        if (name === "./lib/qrl2Target") return { assertQrl2PQPrecompileTarget: async () => {} };
        if (name === "./lib/networkIdentity") return { assertNetworkIdentity: async (_, config) => { assert.equal(config.chainId, 3151909); checks++; return 3151909n; } };
        return realRequire(name);
    };
    vm.runInNewContext(fs.readFileSync(sourceFile, "utf8"), {
        require: mockedRequire, module: moduleMock, __dirname: path.dirname(sourceFile),
        process: { env: { QNS_CONFIG: file } }, console: { log() {} },
    }, { filename: sourceFile });
    await moduleMock.exports.main();
    assert.ok(loadedEnvironment);
    assert.deepEqual(deployments.map((item) => item.name), names);
    assert.equal(checks, 1 + deployments.length + writes.length);
    assert.deepEqual(writes.map((item) => `${item.contract}.${item.method}`), [
        "QNSRegistry.setOwner", "Root.setController", "Root.setSubnodeOwner", "Root.setSubnodeOwner", "QNSRegistry.setSubnodeOwner", "ReverseRegistrar.setDefaultResolver",
    ]);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    const { parseNetworkConfig } = await import("../../sdk/src/networkConfig.js");
    assert.equal(parseNetworkConfig(written).deploymentBlock, 42);
    assert.equal(written.deploymentBlock, 42);
    assert.equal(written.buildTarget, "hyperion");
    assert.equal(written.chainId, 3151909);
    assert.equal(written.contracts.ReverseRegistrar, `Q${"4".repeat(128)}`);
    assert.equal(written.contracts.QRLPublicResolver, `Q${"5".repeat(128)}`);
    assert.equal(deployments[4].args[1], written.contracts.ReverseRegistrar);
    assert.equal(writes.at(-1).args[0], written.contracts.QRLPublicResolver);
    assert.ok(Object.values(written.contracts).every((address) => /^Q[0-9a-f]{128}$/.test(address)));
});

for (const [label, patch] of [
    ["wrong TLD", { tld: "eth" }],
    ["invalid chain", { chainId: 0 }],
    ["fractional chain", { chainId: 1.5 }],
    ["unsafe chain", { chainId: Number.MAX_SAFE_INTEGER + 1 }],
    ["remote HTTP", { rpcUrl: "http://rpc.example.test" }],
    ["RPC credentials", { rpcUrl: "https://user:password@rpc.example.test" }],
    ["RPC fragment", { rpcUrl: "https://rpc.example.test/#rpc" }],
    ["missing genesis", { genesisHash: undefined }],
    ["invalid genesis", { genesisHash: "0x123" }],
    ["wrong precompile set", { qrl2PrecompileSet: "other" }],
    ["missing contracts", { contracts: {} }],
    ["zero address", { contracts: { QNSRegistry: `Q${"0".repeat(128)}` } }],
    ["missing network", { network: "" }],
    ["missing RPC URL", { rpcUrl: undefined }],
    ["invalid address", { contracts: { QNSRegistry: "Q123" } }],
    ["negative deployment block", { deploymentBlock: -1 }],
    ["zero deployment block", { deploymentBlock: 0 }],
    ["fractional deployment block", { deploymentBlock: 1.5 }],
    ["unsafe deployment block", { deploymentBlock: Number.MAX_SAFE_INTEGER + 1 }],
    ["null deployment block", { deploymentBlock: null }],
    ["string deployment block", { deploymentBlock: "4" }],
]) {
    test(`rejects ${label} before initializing a network or signer`, async (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qns-invalid-"));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const file = path.join(directory, "target.json");
        const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../config/testnet-v3.example.json"), "utf8"));
        fs.writeFileSync(file, JSON.stringify({ ...config, ...patch }));
        const original = fs.readFileSync(file, "utf8");
        await assert.rejects(runRejectedDeployment({ QNS_CONFIG: file }), (error) => {
            assert.notEqual(error.code, "ERR_ASSERTION");
            return true;
        });
        assert.equal(fs.readFileSync(file, "utf8"), original);
    });
}

for (const selector of [undefined, "", "   "]) {
    test(`requires QNS_CONFIG (${JSON.stringify(selector)}) before initialization`, async () => {
        await assert.rejects(runRejectedDeployment({ QNS_CONFIG: selector }), /QNS_CONFIG/);
    });
}

async function runRejectedDeployment(env) {
    const sourceFile = path.resolve(__dirname, "../../scripts/deploy-testnet.js");
    const realRequire = createRequire(sourceFile);
    const moduleMock = { exports: {} };
    const calls = [];
    vm.runInNewContext(fs.readFileSync(sourceFile, "utf8"), {
        require: (name) => {
            if (name === "dotenv") return { config() {} };
            if (name === "@theqrl/web3") return { Web3: class { constructor() { calls.push("network"); throw new Error("Network initialized before validation"); } } };
            if (name === "./lib/hyperionArtifacts") return { ...realRequire(name), verifyArtifactManifest() { calls.push("artifacts"); throw new Error("Artifacts initialized before validation"); } };
            return realRequire(name);
        },
        module: moduleMock, __dirname: path.dirname(sourceFile), process: { env }, console: { log() {} },
    }, { filename: sourceFile });
    try {
        await moduleMock.exports.main();
    } finally {
        assert.deepEqual(calls, [], "Validation must precede artifact, network and signer initialization");
    }
}
