const { loadSdk } = require("./sdk");
const { assertGovernanceNetwork, governancePolicy, readPowerState } = require("./governance");

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
        else if (!after.controllers.Root[deployer]) throw new Error("Deployer lacks Root controller authority for reverse assignment");
        transactions.push({ step: transactions.length + 1, contract, method, args,
            from: deployer, to: contracts[contract], value: "0x0", chainId: `0x${BigInt(config.chainId).toString(16)}`,
            data: abi.selector(method) + words });
    };
    // 1. Install the reviewed Root controller set.
    for (const controller of handoff.rootControllers) {
        if (!after.controllers.Root[controller]) {
            add("Root", "setController(address,bool)", [controller, true], abi.addressWord(controller) + abi.uintWord(1n));
            after.controllers.Root[controller] = true;
        }
    }
    // 2. Transfer the reverse parent before any irreversible label lock.
    if (after.nodes.reverse !== handoff.reverseOwner) {
        if (after.locks.reverse) throw new Error("Refusing locked reverse with an unexpected final owner");
        requireEqual(after.nodes.reverse, deployer, "reverse owner before handoff");
        add("Root", "setSubnodeOwner(bytes32,address)", [abi.hashText("reverse"), handoff.reverseOwner],
            abi.bytes32Word(abi.hashText("reverse")) + abi.addressWord(handoff.reverseOwner), "controller");
        after.nodes.reverse = handoff.reverseOwner;
    }
    // 3. Lock only a label already held by its exact final owner.
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
    return { before, transactions, after };
}

function printHandoff(plan, log = console.log) {
    log("Before state:\n" + JSON.stringify(plan.before, null, 2));
    log("Exact transaction calls (gas and nonce are selected at execution):\n" + JSON.stringify(plan.transactions, null, 2));
    log("Projected after state (snapshot block and code observations retained):\n" + JSON.stringify(plan.after, null, 2));
}

async function runHandoff({ web3, config, account, dryRun = false, log = console.log }) {
    const sdk = await loadSdk();
    const policy = governancePolicy(config, sdk, { requireHandoff: true });
    await assertGovernanceNetwork(web3, config);
    let state = await readPowerState(web3, policy, sdk);
    const plan = planHandoff(config, state, sdk);
    printHandoff(plan, log);
    if (dryRun) {
        log(`Dry run: ${plan.transactions.length} transaction(s), none sent.`);
        return plan;
    }
    if (plan.transactions.length && (!account?.address || sdk.canonicalAddress(account.address) !== policy.deployer)) {
        throw new Error("Signing account must match config.deployer");
    }
    for (const planned of plan.transactions) {
        state = await readPowerState(web3, policy, sdk);
        const remaining = planHandoff(config, state, sdk).transactions;
        if (!remaining.some((tx) => tx.to === planned.to && tx.data === planned.data)) continue;
        if (remaining[0].to !== planned.to || remaining[0].data !== planned.data) {
            throw new Error("Handoff state changed; review a fresh dry run");
        }
        const { from, to, data, value } = planned;
        const tx = { from, to, data, value };
        const gas = await web3.qrl.estimateGas(tx);
        const chainId = await assertGovernanceNetwork(web3, config);
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
        log(`${planned.contract}.${planned.method}: ${receipt.transactionHash}`);
        state = await readPowerState(web3, policy, sdk);
        if (planHandoff(config, state, sdk).transactions.some((next) => next.to === to && next.data === data)) {
            throw new Error("Confirmed handoff transaction did not establish its postcondition");
        }
    }
    state = await readPowerState(web3, policy, sdk);
    if (planHandoff(config, state, sdk).transactions.length) throw new Error("Handoff is incomplete");
    log("Verified after state:\n" + JSON.stringify(state, null, 2));
    return { ...plan, after: state };
}

module.exports = { planHandoff, printHandoff, runHandoff };
