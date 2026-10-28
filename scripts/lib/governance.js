const fs = require("node:fs");
const path = require("node:path");
const { keccak256, toChecksumAddress } = require("@theqrl/web3-utils");
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

function addressList(value, label, sdk, checksummed = false) {
    if (!Array.isArray(value)) throw new Error(`${label} must be an explicit address array`);
    const addresses = value.map((address) => checksummed
        ? checksummedAddress(address, label, sdk) : nonzeroAddress(address, label, sdk));
    if (new Set(addresses).size !== addresses.length) throw new Error(`${label} contains duplicates`);
    return addresses;
}

function nonzeroAddress(value, label, sdk) {
    const address = sdk.canonicalAddress(value);
    if (address === sdk.abi.ZERO_ADDRESS) throw new Error(`${label} must be nonzero`);
    return address;
}

function checksummedAddress(value, label, sdk) {
    const address = nonzeroAddress(value, label, sdk);
    if (value !== toChecksumAddress(value.toLowerCase())) {
        throw new Error(`${label} must be the checksummed address`);
    }
    return address;
}

function governancePolicy(config, sdk, { requireHandoff = false } = {}) {
    const contracts = {};
    for (const name of ["QNSRegistry", "Root", "FIFSQRLRegistrar", "ReverseRegistrar", "QRLPublicResolver", "QRLSignatureVerifier"]) {
        contracts[name] = nonzeroAddress(config.contracts?.[name], name, sdk);
    }
    if (config.tld !== "qrl") throw new Error("Governance requires the qrl TLD");
    const deployer = config.deployer ? nonzeroAddress(config.deployer, "deployer", sdk) : null;
    const h = config.handoff;
    if (requireHandoff && (!h || !deployer)) throw new Error("Handoff requires handoff config and deployer");
    let handoff = null;
    if (h !== undefined) {
        if (!h || typeof h !== "object") throw new Error("Invalid handoff config");
        const finalOwner = checksummedAddress(h.finalOwner, "handoff.finalOwner", sdk);
        if (finalOwner === deployer) throw new Error("finalOwner must differ from deployer");
        if (Object.values(contracts).includes(finalOwner)) throw new Error("finalOwner must differ from every configured contract");
        const rootControllers = addressList(h.rootControllers, "handoff.rootControllers", sdk, true);
        if (rootControllers.includes(deployer)) throw new Error("Reviewed controllers must exclude deployer");
        if (!["finalOwner", "root"].includes(h.reverseOwner)) {
            throw new Error("handoff.reverseOwner must be finalOwner or root");
        }
        if (!Array.isArray(h.lockLabels) || new Set(h.lockLabels).size !== h.lockLabels.length ||
            h.lockLabels.some((label) => !["qrl", "reverse"].includes(label))) {
            throw new Error("handoff.lockLabels must be a unique array containing qrl and/or reverse");
        }
        handoff = {
            finalOwner, rootControllers, lockLabels: ["qrl", "reverse"].filter((label) => h.lockLabels.includes(label)),
            reverseOwner: h.reverseOwner === "root" ? contracts.Root : finalOwner,
        };
    }
    const check = config.powerCheck ?? {};
    const controllerMode = check.controllerMode ?? "events";
    if (!["events", "list"].includes(controllerMode)) throw new Error("Invalid powerCheck.controllerMode");
    if (requireHandoff && controllerMode !== "events") throw new Error("Handoff requires powerCheck.controllerMode events");
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
    const labels = Object.fromEntries(["qrl", "reverse"].map((label) => [label, sdk.abi.hashText(label)]));
    const topLevelOwners = {};
    const configuredOwners = check.topLevelOwners ?? {};
    if (!configuredOwners || typeof configuredOwners !== "object" || Array.isArray(configuredOwners)) {
        throw new Error("powerCheck.topLevelOwners must be a labelhash-to-owner map");
    }
    for (const [label, owner] of Object.entries(configuredOwners)) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(label)) throw new Error("Invalid powerCheck.topLevelOwners labelhash");
        const hash = label.toLowerCase();
        if (Object.values(labels).includes(hash)) throw new Error("Configure qrl and reverse owners through the deployment and handoff fields");
        if (Object.hasOwn(topLevelOwners, hash)) throw new Error("Duplicate powerCheck.topLevelOwners labelhash");
        topLevelOwners[hash] = sdk.canonicalAddress(owner);
    }
    return { contracts, deployer, handoff, controllerMode, candidates, reverseControllers, fromBlock, labels, topLevelOwners };
}

async function assertGovernanceNetwork(web3, config) {
    // Handoffs always pin genesis, including on loopback networks.
    if (!/^0x[0-9a-f]{64}$/.test(config.genesisHash ?? "")) {
        throw new Error("Governance config requires an explicit genesisHash");
    }
    return assertNetworkIdentity(web3, config);
}

function createScanCache() {
    return { lastScanned: null, controllers: { Root: new Set(), ReverseRegistrar: new Set() },
        enabling: { Root: new Set(), ReverseRegistrar: new Set() }, labels: new Set() };
}

async function scanLogs(web3, query, start, head, abi, accept) {
    let span = 2000n;
    while (start <= head) {
        const end = start + span - 1n < head ? start + span - 1n : head;
        let logs;
        try {
            // QRVM topics occupy 64 bytes; use the request manager to preserve their width.
            logs = await web3.requestManager.send({ method: "qrl_getLogs", params: [{ ...query,
                fromBlock: abi.toQuantity(start), toBlock: abi.toQuantity(end) }] });
        } catch (error) {
            if (span > 1n && /block|range/i.test(error.message) && /limit|max|exceed|too|at most/i.test(error.message)) {
                span /= 2n;
                continue;
            }
            throw error;
        }
        if (!Array.isArray(logs)) throw new Error("Invalid governance log response");
        for (const log of logs) {
            if (!log || log.removed) throw new Error("Removed or invalid governance log; retry at a stable head");
            const block = abi.quantity(log.blockNumber);
            if (block < start || block > end) throw new Error("Governance log outside requested block range");
            accept(log);
        }
        start = end + 1n;
    }
}

async function discoverPowers(web3, policy, sdk, head, cache) {
    const { abi } = sdk;
    const start = cache.lastScanned === null ? BigInt(policy.fromBlock) : cache.lastScanned + 1n;
    const eventTopic = `0x${abi.bytes32Word(abi.hashText("ControllerChanged(address,bool)"))}`;
    for (const name of ["Root", "ReverseRegistrar"]) {
        await scanLogs(web3, { address: policy.contracts[name], topics: [eventTopic] }, start, head, abi, (log) => {
            if (sdk.canonicalAddress(log.address) !== policy.contracts[name] ||
                log.topics?.length !== 2 || log.topics[0]?.toLowerCase() !== eventTopic) {
                throw new Error("Invalid ControllerChanged log");
            }
            const candidate = abi.decodeAddress(log.topics[1]);
            cache.controllers[name].add(candidate);
            if (abi.decodeBool(log.data)) cache.enabling[name].add(candidate);
        });
    }
    const ownerTopic = `0x${abi.bytes32Word(abi.hashText("NewOwner(bytes32,bytes32,address)"))}`;
    const rootTopic = `0x${"0".repeat(128)}`;
    await scanLogs(web3, { address: policy.contracts.QNSRegistry, topics: [ownerTopic, rootTopic] },
        start, head, abi, (log) => {
            const label = log.topics?.[2];
            if (sdk.canonicalAddress(log.address) !== policy.contracts.QNSRegistry || log.topics?.length !== 3 ||
                log.topics[0]?.toLowerCase() !== ownerTopic || log.topics[1] !== rootTopic ||
                !/^0x[0-9a-fA-F]{128}$/.test(label ?? "") || label.slice(66) !== "0".repeat(64)) {
                throw new Error("Invalid native NewOwner topics");
            }
            abi.decodeAddress(log.data);
            cache.labels.add(label.slice(0, 66).toLowerCase());
        });
    for (const [label, hash] of Object.entries(policy.labels)) {
        if (!cache.labels.has(hash)) {
            throw new Error(`incomplete NewOwner history: missing ${label}; use an RPC with complete logs and the registry deployment block`);
        }
    }
    cache.lastScanned = head;
}

async function readPowerState(web3, policy, sdk, { cache = createScanCache(), minBlock = 0n,
    headAttempts = 10, pollIntervalMs = 1000 } = {}) {
    const { abi } = sdk;
    const minimum = cache.lastScanned !== null && cache.lastScanned > minBlock ? cache.lastScanned : minBlock;
    let head;
    for (let attempt = 0; attempt < headAttempts; attempt++) {
        head = BigInt(await web3.qrl.getBlockNumber());
        if (head >= minimum) break;
        if (attempt + 1 === headAttempts) {
            throw new Error(`RPC head ${head} stays behind required block ${minimum}; wait for the node to catch up, then review a fresh dry run`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
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
    if (policy.controllerMode === "events") await discoverPowers(web3, policy, sdk, head, cache);
    const topLevelOwners = {};
    const labels = new Set([...Object.values(policy.labels), ...Object.keys(policy.topLevelOwners), ...cache.labels]);
    for (const label of [...labels].sort()) {
        const known = Object.keys(policy.labels).find((name) => policy.labels[name] === label);
        const node = keccak256(`0x${"0".repeat(64)}${label.slice(2)}`);
        topLevelOwners[label] = known ? nodes[known] : await address("QNSRegistry", "owner(bytes32)", abi.bytes32Word(node));
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
        ...Object.values(nodes), ...Object.values(topLevelOwners), ...Object.values(policy.contracts)].filter(Boolean);
    for (const name of ["Root", "ReverseRegistrar"]) {
        const candidates = new Set([...common, ...policy.candidates[name], ...cache.controllers[name],
            ...(name === "Root" ? policy.handoff?.rootControllers ?? [] : policy.reverseControllers)]);
        controllers[name] = {};
        for (const candidate of [...candidates].sort()) {
            controllers[name][candidate] = await bool(name, "controllers(address)", abi.addressWord(candidate));
            if (policy.controllerMode === "events" && controllers[name][candidate] && !cache.enabling[name].has(candidate)) {
                throw new Error(`incomplete ControllerChanged history for ${name}: enabled controller ${candidate} has no enabling log; use an RPC with complete logs and the registry deployment block`);
            }
        }
    }
    const code = {};
    const holders = new Set([...Object.values(owners), ...Object.values(nodes), trustedReverseRegistrar,
        defaultResolver, ...Object.values(policy.contracts), ...Object.values(topLevelOwners),
        ...Object.values(controllers).flatMap((entries) => Object.keys(entries))]);
    for (const holder of holders) {
        const bytes = await web3.qrl.getCode(holder, block);
        if (typeof bytes !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(bytes)) {
            throw new Error(`Invalid code response for ${holder}`);
        }
        code[holder] = bytes.length > 2;
    }
    return { block, owners, controllers, nodes, topLevelOwners, locks, trustedReverseRegistrar, defaultResolver, code,
        coverage: policy.controllerMode === "events"
            ? `ControllerChanged and top-level NewOwner history from block ${policy.fromBlock} through ${head}; snapshot mapping probes and positive controls`
            : "Configured controller lists and top-level labels plus known holders only; unlisted controllers and top-level labels may exist" };
}

module.exports = { assertGovernanceNetwork, createScanCache, governancePolicy, loadGovernanceConfig, readPowerState };
