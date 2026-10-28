const { createHash } = require("node:crypto");
const { keccak256 } = require("@theqrl/web3-utils");
const { loadSdk } = require("./sdk");
const { assertGovernanceNetwork, createScanCache, governancePolicy, readPowerState } = require("./governance");

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function hashHandoffPlan(config, policy, transactions) {
    return createHash("sha256").update(canonicalJson({
        chainId: BigInt(config.chainId).toString(), genesisHash: config.genesisHash.toLowerCase(),
        contracts: policy.contracts, deployer: policy.deployer, handoff: policy.handoff, transactions,
    })).digest("hex");
}

function planHandoff(config, before, sdk) {
    const policy = governancePolicy(config, sdk, { requireHandoff: true });
    const { contracts, deployer, handoff } = policy;
    const { abi } = sdk;
    const after = structuredClone(before);
    const transactions = [];
    const requireEqual = (actual, expected, power) => {
        if (actual !== expected) throw new Error(`Unexpected ${power}: ${actual}; expected ${expected}`);
    };
    for (const [node, expected] of [["root", contracts.Root], ["qrl", contracts.FIFSQRLRegistrar],
        ["addr.reverse", contracts.ReverseRegistrar]]) {
        requireEqual(after.nodes[node], expected, `${node} owner`);
    }
    requireEqual(after.trustedReverseRegistrar, contracts.ReverseRegistrar, "trusted reverse registrar");
    requireEqual(after.defaultResolver, contracts.QRLPublicResolver, "default resolver");
    for (const contract of Object.values(contracts)) {
        if (!before.code[contract]) throw new Error(`Missing contract code: ${contract}`);
    }
    for (const holder of [handoff.finalOwner, ...handoff.rootControllers]) {
        if (!before.code[holder]) throw new Error(`Handoff destination must have code at the snapshot: ${holder}`);
    }
    for (const [label, owner] of Object.entries(before.topLevelOwners)) {
        if (!Object.values(policy.labels).includes(label) && owner !== abi.ZERO_ADDRESS && policy.topLevelOwners[label] !== owner) {
            throw new Error(`Unreviewed top-level label ${label}: owner ${owner}`);
        }
    }
    for (const name of ["Root", "ReverseRegistrar"]) {
        if (![deployer, handoff.finalOwner].includes(after.owners[name])) {
            throw new Error(`Unexpected ${name} owner`);
        }
        const expected = name === "Root" ? handoff.rootControllers : policy.reverseControllers;
        for (const [holder, enabled] of Object.entries(after.controllers[name])) {
            if (enabled && holder !== deployer && !expected.includes(holder)) {
                throw new Error(`Unreviewed ${name} controller: ${holder}`);
            }
        }
        if (name === "ReverseRegistrar" && expected.some((holder) => !after.controllers[name][holder])) {
            throw new Error("Expected ReverseRegistrar controller is missing");
        }
    }
    const add = (contract, method, args, words, authority = "owner") => {
        if (authority === "owner") requireEqual(after.owners[contract], deployer, `${contract} signer authority`);
        else if (authority === "registry") requireEqual(after.nodes.reverse, deployer, "reverse signer authority");
        else if (!after.controllers.Root[deployer]) throw new Error("Deployer lacks Root controller authority for reverse assignment");
        transactions.push({ step: transactions.length + 1, contract, method, args,
            from: deployer, to: contracts[contract], value: "0x0", chainId: `0x${BigInt(config.chainId).toString(16)}`,
            data: abi.selector(method) + words });
    };
    // 1. Assign the reverse parent using its current registry or Root authority.
    if (after.nodes.reverse !== handoff.reverseOwner) {
        if (after.nodes.reverse === deployer) {
            const node = sdk.nodeToHex(sdk.namehash("reverse"));
            add("QNSRegistry", "setOwner(bytes32,address)", [node, handoff.reverseOwner],
                abi.bytes32Word(node) + abi.addressWord(handoff.reverseOwner), "registry");
        } else if ([contracts.Root, handoff.finalOwner].includes(after.nodes.reverse) &&
            !after.locks.reverse && after.controllers.Root[deployer]) {
            add("Root", "setSubnodeOwner(bytes32,address)", [abi.hashText("reverse"), handoff.reverseOwner],
                abi.bytes32Word(abi.hashText("reverse")) + abi.addressWord(handoff.reverseOwner), "controller");
        } else {
            throw new Error(`Cannot assign reverse: current owner ${after.nodes.reverse}, locked=${after.locks.reverse}; requires the node owner or enabled deployer Root controller authority`);
        }
        after.nodes.reverse = handoff.reverseOwner;
        after.topLevelOwners[policy.labels.reverse] = handoff.reverseOwner;
    }
    // 2. Lock qrl, then reverse, only after each exact final owner is established.
    for (const label of ["qrl", "reverse"]) {
        const expected = label === "qrl" ? contracts.FIFSQRLRegistrar : handoff.reverseOwner;
        if (handoff.lockLabels.includes(label)) {
            requireEqual(after.nodes[label], expected, `${label} owner before lock`);
            if (!after.locks[label]) {
                add("Root", "lock(bytes32)", [abi.hashText(label)], abi.bytes32Word(abi.hashText(label)));
                after.locks[label] = true;
            }
        } else if (after.locks[label]) {
            throw new Error(`Unexpected irreversible ${label} lock; review handoff.lockLabels`);
        }
    }
    // 3. Install reviewed Root controllers after the irreversible locks.
    for (const controller of handoff.rootControllers) {
        if (!after.controllers.Root[controller]) {
            add("Root", "setController(address,bool)", [controller, true], abi.addressWord(controller) + abi.uintWord(1n));
            after.controllers.Root[controller] = true;
        }
    }
    // 4. Remove the deployer's controller capabilities before ownership moves.
    for (const name of ["Root", "ReverseRegistrar"]) {
        if (after.controllers[name][deployer]) {
            add(name, "setController(address,bool)", [deployer, false], abi.addressWord(deployer) + abi.uintWord(0n));
            after.controllers[name][deployer] = false;
        }
    }
    // 5. Single-step Ownable transfers, with Root first.
    for (const name of ["Root", "ReverseRegistrar"]) {
        if (after.owners[name] !== handoff.finalOwner) {
            add(name, "transferOwnership(address)", [handoff.finalOwner], abi.addressWord(handoff.finalOwner));
            after.owners[name] = handoff.finalOwner;
        }
    }
    return { before, transactions, after, hash: hashHandoffPlan(config, policy, transactions) };
}

function printHandoff(plan, log = console.log) {
    log("Before state:\n" + JSON.stringify(plan.before, null, 2));
    log("Exact transaction calls (gas and nonce are selected at execution):\n" + JSON.stringify(plan.transactions, null, 2));
    log("Projected after state (snapshot block and code observations retained):\n" + JSON.stringify(plan.after, null, 2));
    for (const tx of plan.transactions.filter((entry) => entry.method === "lock(bytes32)")) {
        const label = tx.args[0] === keccak256("qrl") ? "qrl" : "reverse";
        log(`PERMANENT: locking ${label} binds Root assignment to owner ${plan.after.nodes[label]}; Root has no unlock.`);
    }
    log(`Plan hash (SHA-256): ${plan.hash}`);
}

async function assertWiring(web3, config, policy, sdk, block) {
    const provider = { request: ({ method, params = [] }) => web3.requestManager.send({ method,
        params: ["qrl_call", "qrl_getCode"].includes(method) ? [params[0], block] : params }) };
    await sdk.assertDeployment({ config: { ...config, contracts: policy.contracts }, provider });
    if (sdk.abi.decodeAddress(await sdk.abi.call(provider, policy.contracts.Root, "qns()")) !== policy.contracts.QNSRegistry) {
        throw new Error("Root registry wiring mismatch");
    }
}

async function runHandoff({ web3, config, account, loadAccount, dryRun = true, executeHash,
    log = console.log, pollIntervalMs = 1000, headAttempts = 10 }) {
    const sdk = await loadSdk();
    const policy = governancePolicy(config, sdk, { requireHandoff: true });
    const chainId = await assertGovernanceNetwork(web3, config);
    const cache = createScanCache();
    let minBlock = 0n;
    const snapshot = () => readPowerState(web3, policy, sdk, { cache, minBlock, pollIntervalMs, headAttempts });
    let state = await snapshot();
    await assertWiring(web3, config, policy, sdk, state.block);
    const plan = planHandoff(config, state, sdk);
    printHandoff(plan, log);
    if (dryRun) {
        log(`Dry run: ${plan.transactions.length} transaction(s), none sent.`);
        log(`With the same QNS_CONFIG, execute this plan: npm run handoff -- --execute ${plan.hash}`);
        return plan;
    }
    if (executeHash !== plan.hash) {
        throw new Error("state or configuration changed since the reviewed dry run; review a fresh dry run");
    }
    if (plan.transactions.length && loadAccount) account = await loadAccount(chainId);
    if (plan.transactions.length && (!account?.address || sdk.canonicalAddress(account.address) !== policy.deployer)) {
        throw new Error("Signing account must match config.deployer");
    }
    for (const [index, planned] of plan.transactions.entries()) {
        state = await snapshot();
        const remaining = planHandoff(config, state, sdk).transactions;
        const reviewed = plan.transactions.slice(index).map((tx, offset) => ({ ...tx, step: offset + 1 }));
        if (canonicalJson(remaining) !== canonicalJson(reviewed)) {
            throw new Error("Handoff state changed; review a fresh dry run");
        }
        const { from, to, data, value } = planned;
        const tx = { from, to, data, value };
        const gas = await web3.qrl.estimateGas(tx);
        const chainId = await assertGovernanceNetwork(web3, config);
        const latest = BigInt(await web3.qrl.getTransactionCount(policy.deployer, "latest"));
        const pending = BigInt(await web3.qrl.getTransactionCount(policy.deployer, "pending"));
        if (pending > latest) {
            throw new Error("the deployer has a pending transaction; wait until it settles, then review a fresh dry run");
        }
        // Recheck lock ownership after estimation, immediately before submission.
        if (planned.method === "lock(bytes32)") {
            const label = planned.args[0] === sdk.abi.hashText("qrl") ? "qrl" : "reverse";
            const expected = label === "qrl" ? policy.contracts.FIFSQRLRegistrar : policy.handoff.reverseOwner;
            const owner = sdk.abi.decodeAddress(await web3.qrl.call({ to: policy.contracts.QNSRegistry,
                data: sdk.abi.selector("owner(bytes32)") + sdk.abi.bytes32Word(sdk.nodeToHex(sdk.namehash(label))) }, "latest"));
            if (owner !== expected) throw new Error(`Refusing to lock ${label}: unexpected owner`);
        }
        const receipt = await web3.qrl.sendTransaction({ ...tx, chainId, gas: (BigInt(gas) * 120n + 99n) / 100n });
        if (receipt?.status === undefined || BigInt(receipt.status) !== 1n) throw new Error("Handoff transaction failed");
        if (receipt.blockNumber === undefined || BigInt(receipt.blockNumber) < 0n) throw new Error("Invalid handoff receipt block number");
        minBlock = BigInt(receipt.blockNumber);
        log(`${planned.contract}.${planned.method}: ${receipt.transactionHash}`);
        state = await snapshot();
        if (planHandoff(config, state, sdk).transactions.some((next) => next.to === to && next.data === data)) {
            throw new Error("Confirmed handoff transaction did not establish its postcondition");
        }
    }
    state = await snapshot();
    if (planHandoff(config, state, sdk).transactions.length) throw new Error("Handoff is incomplete");
    log("Verified after state:\n" + JSON.stringify(state, null, 2));
    return { ...plan, after: state };
}

module.exports = { hashHandoffPlan, planHandoff, printHandoff, runHandoff };
