const { loadSdk } = require("./sdk");
const { assertGovernanceNetwork, governancePolicy, readPowerState } = require("./governance");

function assessPowers(state, policy) {
    const rows = [];
    const violations = [];
    const row = (power, observed, expected, code, problems) => {
        rows.push({ power, observed: String(observed), expected: String(expected ?? "unconfigured"),
            code, status: problems.length ? problems.join(", ") : "OK" });
        for (const kind of problems) violations.push({ power, kind });
    };
    const holder = (power, actual, expected) => {
        const problems = [];
        if (!state.code[actual]) problems.push("NO_CODE");
        if (expected === undefined) problems.push("MISSING_EXPECTATION");
        else if (actual !== expected) problems.push("UNEXPECTED_HOLDER");
        row(power, actual, expected, state.code[actual] ? "yes" : "no", problems);
    };
    const { contracts, handoff } = policy;
    holder("Root.owner", state.owners.Root, handoff?.finalOwner);
    holder("ReverseRegistrar.owner", state.owners.ReverseRegistrar, handoff?.finalOwner);
    holder("registry.owner(root)", state.nodes.root, contracts.Root);
    holder("registry.owner(qrl)", state.nodes.qrl, contracts.FIFSQRLRegistrar);
    holder("registry.owner(reverse)", state.nodes.reverse, handoff?.reverseOwner);
    holder("registry.owner(addr.reverse)", state.nodes["addr.reverse"], contracts.ReverseRegistrar);
    holder("ReverseRegistrar.defaultResolver", state.defaultResolver, contracts.QRLPublicResolver);
    holder("resolver.trustedReverseRegistrar", state.trustedReverseRegistrar, contracts.ReverseRegistrar);
    row("trusted registrar == addr.reverse owner", state.trustedReverseRegistrar === state.nodes["addr.reverse"], true,
        "-", state.trustedReverseRegistrar === state.nodes["addr.reverse"] ? [] : ["TRUST_MISMATCH"]);
    for (const name of ["Root", "ReverseRegistrar"]) {
        const expected = name === "Root" ? handoff?.rootControllers : policy.reverseControllers;
        for (const [address, enabled] of Object.entries(state.controllers[name])) {
            const wanted = expected?.includes(address);
            const problems = [];
            if (enabled && !state.code[address]) problems.push("NO_CODE");
            if (wanted === undefined) problems.push("MISSING_EXPECTATION");
            else if (enabled && !wanted) problems.push("UNEXPECTED_HOLDER");
            else if (!enabled && wanted) problems.push("MISSING_CONTROLLER");
            row(`${name}.controllers(${address})`, enabled, wanted,
                enabled ? (state.code[address] ? "yes" : "no") : "-", problems);
        }
    }
    for (const label of ["qrl", "reverse"]) {
        const expected = handoff?.lockLabels.includes(label);
        row(`Root.locked(${label})`, state.locks[label], expected, "-",
            expected === undefined ? ["MISSING_EXPECTATION"] : state.locks[label] === expected ? [] : ["LOCK_MISMATCH"]);
    }
    return { rows, violations };
}

function printPowerReport(report, state, { reportOnly = false, log = console.log } = {}) {
    log(`Power snapshot: block ${state.block}`);
    log(`Controller coverage: ${state.coverage}`);
    log("Power | Observed | Expected | Code | Status");
    log("--- | --- | --- | --- | ---");
    for (const row of report.rows) log([row.power, row.observed, row.expected, row.code, row.status].join(" | "));
    log(`${report.violations.length} violation(s). Mode: ${reportOnly ? "report-only" : "enforce"}.`);
}

async function checkPowers({ web3, config, reportOnly = false, log = console.log }) {
    const sdk = await loadSdk();
    const policy = governancePolicy(config, sdk);
    await assertGovernanceNetwork(web3, config);
    const state = await readPowerState(web3, policy, sdk);
    const report = assessPowers(state, policy);
    printPowerReport(report, state, { reportOnly, log });
    return { ...report, state, exitCode: reportOnly || report.violations.length === 0 ? 0 : 1 };
}

module.exports = { assessPowers, checkPowers, printPowerReport };
