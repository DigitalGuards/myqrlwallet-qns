const fs = require("node:fs");
const path = require("node:path");
const { loadSdk } = require("./sdk");
const { assertNetworkIdentity } = require("./networkIdentity");

async function loadGovernanceConfig(selector) {
    if (typeof selector !== "string" || !selector.trim()) {
        throw new Error("Set QNS_CONFIG to an existing deployment configuration");
    }
    const file = path.resolve(__dirname, "../..", selector);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const sdk = await loadSdk();
    return { ...raw, ...sdk.parseNetworkConfig(raw) };
}

function addressList(value, label, sdk) {
    if (!Array.isArray(value)) throw new Error(`${label} must be an explicit address array`);
    const addresses = value.map((address) => nonzeroAddress(address, label, sdk));
    if (new Set(addresses).size !== addresses.length) throw new Error(`${label} contains duplicates`);
    return addresses;
}

function nonzeroAddress(value, label, sdk) {
    const address = sdk.canonicalAddress(value);
    if (address === sdk.abi.ZERO_ADDRESS) throw new Error(`${label} must be nonzero`);
    return address;
}

function governancePolicy(config, sdk, { requireHandoff = false } = {}) {
    const contracts = {};
    for (const name of ["QNSRegistry", "Root", "FIFSQRLRegistrar", "ReverseRegistrar", "QRLPublicResolver"]) {
        contracts[name] = nonzeroAddress(config.contracts?.[name], name, sdk);
    }
    if (config.tld !== "qrl") throw new Error("Governance requires the qrl TLD");
    const deployer = config.deployer ? nonzeroAddress(config.deployer, "deployer", sdk) : null;
    const h = config.handoff;
    if (requireHandoff && (!h || !deployer)) throw new Error("Handoff requires handoff config and deployer");
    let handoff = null;
    if (h !== undefined) {
        if (!h || typeof h !== "object") throw new Error("Invalid handoff config");
        const finalOwner = nonzeroAddress(h.finalOwner, "handoff.finalOwner", sdk);
        if (finalOwner === deployer) throw new Error("finalOwner must differ from deployer");
        const rootControllers = addressList(h.rootControllers, "handoff.rootControllers", sdk);
        if (rootControllers.includes(deployer)) throw new Error("Reviewed controllers must exclude deployer");
        if (!["finalOwner", "root"].includes(h.reverseOwner)) {
            throw new Error("handoff.reverseOwner must be finalOwner or root");
        }
        if (!Array.isArray(h.lockLabels) || new Set(h.lockLabels).size !== h.lockLabels.length ||
            h.lockLabels.some((label) => !["qrl", "reverse"].includes(label))) {
            throw new Error("handoff.lockLabels must be a unique array containing qrl and/or reverse");
        }
        handoff = {
            finalOwner, rootControllers, lockLabels: h.lockLabels,
            reverseOwner: h.reverseOwner === "root" ? contracts.Root : finalOwner,
        };
    }
    const check = config.powerCheck ?? {};
    const controllerMode = check.controllerMode ?? "events";
    if (!["events", "list"].includes(controllerMode)) throw new Error("Invalid powerCheck.controllerMode");
    const candidates = {};
    for (const name of ["Root", "ReverseRegistrar"]) {
        const list = check.controllerCandidates?.[name];
        candidates[name] = addressList(list ?? (controllerMode === "events" ? [] : undefined),
            `powerCheck.controllerCandidates.${name}`, sdk);
    }
    const reverseControllers = addressList(check.reverseControllers ?? [], "powerCheck.reverseControllers", sdk);
    if (reverseControllers.includes(deployer)) throw new Error("Expected reverse controllers must exclude deployer");
    const fromBlock = config.deploymentBlock ?? 1;
    if (!Number.isSafeInteger(fromBlock) || fromBlock < 1) throw new Error("Invalid deploymentBlock");
    return { contracts, deployer, handoff, controllerMode, candidates, reverseControllers, fromBlock };
}

async function assertGovernanceNetwork(web3, config) {
    // Handoffs always pin genesis, including on loopback networks.
    if (!/^0x[0-9a-f]{64}$/.test(config.genesisHash ?? "")) {
        throw new Error("Governance config requires an explicit genesisHash");
    }
    return assertNetworkIdentity(web3, config);
}

async function readPowerState(web3, policy, sdk) {
    const { abi } = sdk;
    const head = BigInt(await web3.qrl.getBlockNumber());
    if (head < BigInt(policy.fromBlock)) throw new Error("deploymentBlock is ahead of the snapshot");
    const block = abi.toQuantity(head);
    const read = async (contract, signature, args = "") =>
        web3.qrl.call({ to: policy.contracts[contract], data: abi.selector(signature) + args }, block);
    const address = async (contract, signature, args) => abi.decodeAddress(await read(contract, signature, args));
    const bool = async (contract, signature, args) => abi.decodeBool(await read(contract, signature, args));
    const nodes = {};
    for (const name of ["", "qrl", "reverse", "addr.reverse"]) {
        nodes[name || "root"] = await address("QNSRegistry", "owner(bytes32)", abi.bytes32Word(sdk.nodeToHex(sdk.namehash(name))));
    }
    const locks = {};
    for (const label of ["qrl", "reverse"]) {
        locks[label] = await bool("Root", "locked(bytes32)", abi.bytes32Word(abi.hashText(label)));
    }
    const owners = {
        Root: await address("Root", "owner()"),
        ReverseRegistrar: await address("ReverseRegistrar", "owner()"),
    };
    const trustedReverseRegistrar = await address("QRLPublicResolver", "trustedReverseRegistrar()");
    const defaultResolver = await address("ReverseRegistrar", "defaultResolver()");
    const controllers = {};
    const common = [policy.deployer, policy.handoff?.finalOwner, ...Object.values(owners),
        ...Object.values(nodes), ...Object.values(policy.contracts)].filter(Boolean);
    const eventTopic = `0x${abi.bytes32Word(abi.hashText("ControllerChanged(address,bool)"))}`;
    for (const name of ["Root", "ReverseRegistrar"]) {
        const candidates = new Set([...common, ...policy.candidates[name],
            ...(name === "Root" ? policy.handoff?.rootControllers ?? [] : policy.reverseControllers)]);
        if (policy.controllerMode === "events") {
            let span = 2000n;
            for (let start = BigInt(policy.fromBlock); start <= head;) {
                const end = start + span - 1n < head ? start + span - 1n : head;
                let logs;
                try {
                    // QRVM log topics are 64-byte words. @theqrl/web3 1.0.3 getPastLogs validates
                    // topics as 32 bytes, so send qrl_getLogs through the request manager.
                    logs = await web3.requestManager.send({ method: "qrl_getLogs", params: [{
                        address: policy.contracts[name], fromBlock: abi.toQuantity(start),
                        toBlock: abi.toQuantity(end), topics: [eventTopic] }] });
                } catch (error) {
                    if (span > 1n && /block|range/i.test(error.message) && /limit|max|exceed|too|at most/i.test(error.message)) {
                        span /= 2n;
                        continue;
                    }
                    throw error;
                }
                if (!Array.isArray(logs)) throw new Error("Invalid controller log response");
                for (const log of logs) {
                    if (sdk.canonicalAddress(log.address) !== policy.contracts[name] ||
                        log.topics?.length !== 2 || log.topics[0]?.toLowerCase() !== eventTopic) {
                        throw new Error("Invalid ControllerChanged log");
                    }
                    if (log.removed) throw new Error("Removed controller log; retry at a stable head");
                    // Logs discover candidates. The mapping at the snapshot determines authority.
                    candidates.add(abi.decodeAddress(log.topics[1]));
                    abi.decodeBool(log.data);
                }
                start = end + 1n;
            }
        }
        controllers[name] = {};
        for (const candidate of [...candidates].sort()) {
            controllers[name][candidate] = await bool(name, "controllers(address)", abi.addressWord(candidate));
        }
    }
    const code = {};
    const holders = new Set([...Object.values(owners), ...Object.values(nodes), trustedReverseRegistrar,
        defaultResolver, ...Object.values(policy.contracts),
        ...Object.values(controllers).flatMap((entries) => Object.keys(entries))]);
    for (const holder of holders) {
        const bytes = await web3.qrl.getCode(holder, block);
        if (typeof bytes !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(bytes)) {
            throw new Error(`Invalid code response for ${holder}`);
        }
        code[holder] = bytes.length > 2;
    }
    return { block, owners, controllers, nodes, locks, trustedReverseRegistrar, defaultResolver, code,
        coverage: policy.controllerMode === "events"
            ? `ControllerChanged candidates from block ${policy.fromBlock} through ${head}; live mapping probes`
            : "Configured controller lists plus known holders only; unlisted controllers may exist" };
}

module.exports = { assertGovernanceNetwork, governancePolicy, loadGovernanceConfig, readPowerState };
