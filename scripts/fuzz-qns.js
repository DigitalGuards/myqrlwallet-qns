// Differential stateful fuzzer for the QNS contracts.
//
// A seeded generator produces random operation sequences over several actors
// and names. Each sequence runs on qrvmone in process (the worktree QRVM
// driver linked with the hyptest host) against the compiled QNS bytecode, and
// every step's status, return data, ordered logs and full observable state are
// compared with the JavaScript reference model. A mismatch prints the seed, a
// replay command and a minimised failing sequence, and the process exits 1.
//
// Usage: node scripts/fuzz-qns.js [--profile ci|long] [--sequences N]
//   [--length L] [--seed S] [--modes all|via-ir-optimized,legacy,...]
//   [--jobs J] [--batch B] [--replay SEQUENCE_SEED] [--report PATH]
//   [--self-test] [--mutation NAME]
// Precedence: command-line flags, then QNS_FUZZ_SEQUENCES, QNS_FUZZ_LENGTH,
// QNS_FUZZ_SEED and QNS_FUZZ_JOBS, then the profile defaults.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const abi = require("./lib/fuzz/abi64");
const { STATUS, command, runDriver } = require("./lib/fuzz/driver");
const { CONSTRUCTORS, encodeFunction } = require("./lib/fuzz/interface");
const { MUTATIONS, applyStep, emptyState, setMutation } = require("./lib/fuzz/model");
const { OBSERVATIONS, digestOf, expectedOutputs, viewListCommands } = require("./lib/fuzz/observe");
const { generateSequence, sequenceSeed } = require("./lib/fuzz/generator");
const { prepareArtifacts, MODES } = require("./lib/fuzz/artifacts");
const W = require("./lib/fuzz/world");

const PROFILES = Object.freeze({
    ci: { sequences: 300, length: 25, seed: "qns-ci", modes: Object.keys(MODES), jobs: 1 },
    long: { sequences: 20000, length: 30, seed: "qns-long", modes: ["via-ir-optimized"], jobs: 2 },
});

function parseArguments(argv, env = process.env) {
    const flags = {};
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--self-test") {
            flags.selfTest = true;
            continue;
        }
        const [key, inline] = argv[i].split("=");
        const value = inline ?? argv[++i];
        if (value === undefined) throw new Error(`missing value for ${key}`);
        const name = {
            "--profile": "profile",
            "--sequences": "sequences",
            "--length": "length",
            "--seed": "seed",
            "--modes": "modes",
            "--jobs": "jobs",
            "--batch": "batch",
            "--replay": "replay",
            "--report": "report",
            "--mutation": "mutation",
            "--shard": "shard",
        }[key];
        if (!name) throw new Error(`unknown option ${key}`);
        flags[name] = value;
    }
    const profile = PROFILES[flags.profile ?? "ci"];
    if (!profile) throw new Error(`unknown profile ${flags.profile}`);
    const pick = (name, envName, convert = (value) => value) =>
        flags[name] !== undefined
            ? convert(flags[name])
            : env[envName] !== undefined && env[envName] !== ""
              ? convert(env[envName])
              : profile[name];
    const options = {
        profile: flags.profile ?? "ci",
        sequences: pick("sequences", "QNS_FUZZ_SEQUENCES", Number),
        length: pick("length", "QNS_FUZZ_LENGTH", Number),
        seed: pick("seed", "QNS_FUZZ_SEED"),
        jobs: pick("jobs", "QNS_FUZZ_JOBS", Number),
        modes:
            flags.modes === undefined
                ? profile.modes
                : flags.modes === "all"
                  ? Object.keys(MODES)
                  : flags.modes.split(","),
        batch: flags.batch === undefined ? 200 : Number(flags.batch),
        replay: flags.replay === undefined ? null : Number(flags.replay),
        report: flags.report ?? null,
        mutation: flags.mutation ?? null,
        selfTest: Boolean(flags.selfTest),
        shard: null,
    };
    if (flags.shard !== undefined) {
        const [index, count] = flags.shard.split("/").map(Number);
        if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || index >= count) {
            throw new Error("--shard must be INDEX/COUNT");
        }
        options.shard = { index, count };
    }
    for (const name of ["sequences", "length", "jobs", "batch"]) {
        if (!Number.isSafeInteger(options[name]) || options[name] <= 0) {
            throw new Error(`--${name} must be a positive integer`);
        }
    }
    if (options.replay !== null && !Number.isSafeInteger(options.replay)) throw new Error("--replay takes a sequence seed");
    for (const mode of options.modes) if (!MODES[mode]) throw new Error(`unknown codegen mode ${mode}`);
    return options;
}

// ---- readable names for reports ----
const NAMES = new Map([
    ...Object.entries(W.ACTORS).map(([name, value]) => [value, name]),
    ...Object.entries(W.CONTRACTS).map(([name, value]) => [value, `<${name}>`]),
    ...Object.entries(W.NODES).map(([name, value]) => [value, `node:${name}`]),
    ...Object.entries(W.LABELS).map(([name, value]) => [value, `label:${name}`]),
    [W.ZERO, "zero"],
]);
const describeValue = (value) =>
    typeof value === "bigint"
        ? `${value}`
        : typeof value === "string"
          ? (NAMES.get(value) ?? JSON.stringify(value))
          : JSON.stringify(value);
const describeStep = (step) =>
    step.deploy
        ? `${step.actor} deploys ${step.deploy}`
        : `${step.actor} -> ${step.contract}.${step.fn}(${step.args.map(describeValue).join(", ")})`;

// ---- commands and expectations ----
function stepCommand(step, artifacts) {
    const sender = W.ACTORS[step.actor];
    if (step.deploy) {
        const initcode = artifacts[step.deploy] + abi.hex(abi.encode(CONSTRUCTORS[step.deploy], step.args));
        return command("create", sender, initcode);
    }
    return command("call", sender, W.CONTRACTS[step.contract], abi.hex(encodeFunction(step.contract, step.fn, step.args)));
}

const digestCache = new WeakMap();
function stateDigest(state) {
    let digest = digestCache.get(state);
    if (!digest) {
        digest = digestOf(expectedOutputs(state));
        digestCache.set(state, digest);
    }
    return digest;
}

function replayModel(initialState, steps) {
    let state = initialState;
    const results = [];
    const states = [];
    for (const step of steps) {
        const applied = applyStep(state, step);
        state = applied.state;
        results.push(applied.result);
        states.push(state);
    }
    return { steps, results, states };
}

function modelSetup() {
    const setup = replayModel(emptyState(), W.SETUP);
    setup.results.forEach((result, i) => {
        if (result.status !== "success") throw new Error(`model rejects setup step ${describeStep(W.SETUP[i])}`);
    });
    return { ...setup, state: setup.states.at(-1) };
}

function compareResult(expected, reply) {
    const expectedStatus = expected.status === "success" ? STATUS.success : STATUS.revert;
    const problems = [];
    if (reply.status !== expectedStatus) problems.push(`status ${reply.status}, expected ${expectedStatus}`);
    if (expected.created && reply.created !== expected.created) problems.push(`created ${reply.created}`);
    if (!reply.output.equals(expected.output)) {
        problems.push(`output 0x${abi.hex(reply.output)}, expected 0x${abi.hex(expected.output)}`);
    }
    const sameLogs =
        reply.logs.length === expected.logs.length &&
        reply.logs.every(
            (log, i) =>
                log.address === expected.logs[i].address &&
                log.data.equals(expected.logs[i].data) &&
                log.topics.length === expected.logs[i].topics.length &&
                log.topics.every((topic, j) => topic.equals(expected.logs[i].topics[j]))
        );
    if (!sameLogs) {
        const render = (logs) =>
            logs
                .map(
                    (log) =>
                        `${NAMES.get(log.address) ?? log.address} [${log.topics.map((t) => abi.hex(t)).join(",")}] 0x${abi.hex(log.data)}`
                )
                .join("; ") || "none";
        problems.push(`logs ${render(reply.logs)}, expected ${render(expected.logs)}`);
    }
    return problems.length ? problems.join("; ") : null;
}

// Runs sequences (each { steps, results, states }) in one driver process,
// after replaying and checking the deployment. Returns the first mismatch of
// each sequence, or null.
function runSequences(context, sequences, setup) {
    const commands = [...viewListCommands()];
    for (const step of W.SETUP) commands.push(stepCommand(step, context.artifacts), "observe");
    commands.push("snapshot");
    for (const sequence of sequences) {
        commands.push("restore");
        for (const step of sequence.steps) commands.push(stepCommand(step, context.artifacts), "observe");
    }
    const replies = runDriver(context.host, commands).filter((reply) => reply.kind !== "viewlist");
    let cursor = 0;
    const take = () => replies[cursor++];
    for (let i = 0; i < W.SETUP.length; i++) {
        const problem = compareResult(setup.results[i], take());
        const observed = take();
        if (problem || observed.digest !== stateDigest(setup.states[i])) {
            throw new Error(`setup step ${i} (${describeStep(W.SETUP[i])}) diverged: ${problem || "observable state"}`);
        }
    }
    take(); // snapshot
    return sequences.map((sequence) => {
        take(); // restore
        let mismatch = null;
        sequence.steps.forEach((step, index) => {
            const reply = take();
            const observed = take();
            if (mismatch) return;
            const problem = compareResult(sequence.results[index], reply);
            if (problem) mismatch = { index, kind: "result", detail: problem };
            else if (observed.digest !== stateDigest(sequence.states[index])) {
                mismatch = { index, kind: "state", detail: "observable state differs" };
            }
        });
        return mismatch;
    });
}

// Lists the observations that differ after the given steps.
function stateDiff(context, setup, steps) {
    const commands = [...viewListCommands()];
    for (const step of [...W.SETUP, ...steps]) commands.push(stepCommand(step, context.artifacts));
    commands.push("observe-verbose");
    const replies = runDriver(context.host, commands);
    const actual = replies[replies.length - 1].views;
    const expected = expectedOutputs(replayModel(setup.state, steps).states.at(-1) ?? setup.state);
    const differences = [];
    OBSERVATIONS.forEach(([contract, fn, args], i) => {
        if (actual[i].status !== 0 || !actual[i].output.equals(expected[i])) {
            differences.push(
                `${contract}.${fn}(${args.map(describeValue).join(", ")}): VM 0x${abi.hex(actual[i].output)} ` +
                    `(status ${actual[i].status}), model 0x${abi.hex(expected[i])}`
            );
        }
    });
    return differences;
}

// Greedy delta debugging over the failing prefix.
function minimise(context, setup, steps) {
    const fails = (candidate) => runSequences(context, [replayModel(setup.state, candidate)], setup)[0] !== null;
    let current = steps;
    for (let chunk = Math.max(1, Math.floor(current.length / 2)); chunk >= 1; chunk = Math.floor(chunk / 2)) {
        let start = 0;
        while (start < current.length) {
            const candidate = [...current.slice(0, start), ...current.slice(start + chunk)];
            if (candidate.length > 0 && fails(candidate)) current = candidate;
            else start += chunk;
        }
        if (chunk === 1) break;
    }
    return current;
}

function reportMismatch(context, setup, options, mode, sequence, mismatch) {
    const prefix = sequence.steps.slice(0, mismatch.index + 1);
    const minimal = minimise(context, setup, prefix);
    const planted = options.mutation ? ` --mutation ${options.mutation}` : "";
    const lines = [
        `MISMATCH mode=${mode} seed=${options.seed} sequenceSeed=${sequence.seed} step=${mismatch.index + 1}`,
        `  ${mismatch.kind}: ${mismatch.detail}`,
        `  replay: node scripts/fuzz-qns.js --modes ${mode} --length ${options.length} --replay ${sequence.seed}${planted}`,
        `  minimal failing sequence (${minimal.length} of ${prefix.length} steps):`,
        ...minimal.map((step, i) => `    ${i + 1}. ${describeStep(step)}`),
    ];
    const recheck = runSequences(context, [replayModel(setup.state, minimal)], setup)[0];
    if (recheck) {
        lines.push(`  first divergence at step ${recheck.index + 1}: ${recheck.detail}`);
        if (recheck.kind === "state") {
            for (const line of stateDiff(context, setup, minimal.slice(0, recheck.index + 1))) lines.push(`    ${line}`);
        }
    }
    console.log(`\n${lines.join("\n")}`);
    return {
        mode,
        sequenceSeed: sequence.seed,
        step: mismatch.index + 1,
        detail: mismatch.detail,
        minimal: minimal.map(describeStep),
    };
}

// Plants each model mutation in turn and requires the fuzzer to notice it.
function selfTest(host, options) {
    const context = { host, artifacts: prepareArtifacts("via-ir-optimized") };
    const sequencesPerMutation = Math.min(options.sequences, 200);
    let missed = 0;
    for (const [name, description] of Object.entries(MUTATIONS)) {
        setMutation(name);
        let detected = null;
        try {
            const setup = modelSetup();
            for (let i = 0; i < sequencesPerMutation && !detected; i += 25) {
                const sequences = Array.from({ length: Math.min(25, sequencesPerMutation - i) }, (_, j) => {
                    const seed = sequenceSeed(`${options.seed}:self-test`, i + j);
                    return { seed, ...generateSequence(seed, options.length, setup.state) };
                });
                const outcomes = runSequences(context, sequences, setup);
                const index = outcomes.findIndex(Boolean);
                if (index >= 0) detected = `sequence ${i + index}, step ${outcomes[index].index + 1}, ${outcomes[index].kind}`;
            }
        } catch (error) {
            detected = `setup: ${error.message.split(":")[0]}`;
        } finally {
            setMutation(null);
        }
        if (!detected) missed += 1;
        console.log(`  ${detected ? "detected" : "MISSED  "} ${name} (${description})${detected ? `: ${detected}` : ""}`);
    }
    const total = Object.keys(MUTATIONS).length;
    console.log(`Fuzzer self-test: ${total - missed}/${total} planted model mutations detected.`);
    return missed === 0;
}

function runMode(host, setup, options, mode) {
    const context = { host, artifacts: prepareArtifacts(mode) };
    const started = Date.now();
    let indices = Array.from({ length: options.sequences }, (_, i) => i);
    if (options.shard) indices = indices.filter((i) => i % options.shard.count === options.shard.index);
    const seeds = options.replay !== null ? [options.replay] : indices.map((i) => sequenceSeed(options.seed, i));
    const summary = { sequences: seeds.length, steps: 0, reverted: 0, silentChanges: [], operations: {}, mismatches: [] };
    const found = [];
    for (let offset = 0; offset < seeds.length; offset += options.batch) {
        const sequences = seeds.slice(offset, offset + options.batch).map((seed) => ({
            seed,
            ...generateSequence(seed, options.length, setup.state),
        }));
        const outcomes = runSequences(context, sequences, setup);
        sequences.forEach((sequence, i) => {
            sequence.steps.forEach((step, j) => {
                const key = `${step.contract}.${step.fn}`;
                const counts = (summary.operations[key] ??= { success: 0, revert: 0 });
                counts[sequence.results[j].status] += 1;
                // Event completeness: a call that changes observable state must log.
                const before = j === 0 ? setup.state : sequence.states[j - 1];
                if (
                    sequence.results[j].status === "success" &&
                    sequence.results[j].logs.length === 0 &&
                    stateDigest(before) !== stateDigest(sequence.states[j]) &&
                    summary.silentChanges.length < 20
                ) {
                    summary.silentChanges.push(`sequence ${sequence.seed} step ${j + 1}: ${describeStep(step)}`);
                }
            });
            summary.steps += sequence.steps.length;
            summary.reverted += sequence.results.filter((result) => result.status === "revert").length;
            if (outcomes[i]) found.push({ sequence, mismatch: outcomes[i] });
        });
        if (process.stdout.isTTY && seeds.length > options.batch) {
            process.stdout.write(`  ${mode}: ${Math.min(offset + options.batch, seeds.length)}/${seeds.length} sequences\r`);
        }
    }
    summary.seconds = (Date.now() - started) / 1000;
    for (const { sequence, mismatch } of found.slice(0, 3)) {
        summary.mismatches.push(reportMismatch(context, setup, options, mode, sequence, mismatch));
    }
    summary.mismatchCount = found.length;
    return summary;
}

function printSummary(mode, summary) {
    console.log(
        `${mode}: ${summary.sequences} sequences, ${summary.steps} steps (${summary.reverted} expected reverts), ` +
            `${OBSERVATIONS.length} views compared after every step, ${summary.mismatchCount} mismatches, ` +
            `${summary.silentChanges.length} silent state changes, ${summary.seconds.toFixed(1)} s`
    );
    for (const line of summary.silentChanges) console.log(`  silent state change: ${line}`);
}

// Splits the seeds over niced worker processes and merges their reports.
async function runSharded(options) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qns-fuzz-"));
    const started = Date.now();
    const dropped = new Set(["--jobs", "--report"]);
    const passthrough = [];
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i].split("=")[0];
        if (!dropped.has(key)) passthrough.push(argv[i]);
        else if (!argv[i].includes("=")) i++;
    }
    try {
        const reports = await Promise.all(
            Array.from({ length: options.jobs }, (_, index) => {
                const report = path.join(directory, `shard-${index}.json`);
                const args = ["-n", "10", process.execPath, __filename, ...passthrough];
                args.push("--jobs", "1", "--shard", `${index}/${options.jobs}`, "--report", report);
                return new Promise((resolve, reject) => {
                    const child = spawn("nice", args, { stdio: "inherit" });
                    child.on("error", reject);
                    child.on("exit", () => {
                        try {
                            resolve(JSON.parse(fs.readFileSync(report, "utf8")));
                        } catch {
                            reject(new Error(`fuzz shard ${index} produced no report`));
                        }
                    });
                });
            })
        );
        const merged = { ...reports[0], shard: null, shards: options.jobs, modes: {} };
        console.log(`Merged ${options.jobs} shards:`);
        for (const mode of options.modes) {
            const parts = reports.map((report) => report.modes[mode]);
            const operations = {};
            for (const part of parts) {
                for (const [key, counts] of Object.entries(part.operations)) {
                    operations[key] ??= { success: 0, revert: 0 };
                    operations[key].success += counts.success;
                    operations[key].revert += counts.revert;
                }
            }
            merged.modes[mode] = {
                sequences: parts.reduce((sum, part) => sum + part.sequences, 0),
                steps: parts.reduce((sum, part) => sum + part.steps, 0),
                reverted: parts.reduce((sum, part) => sum + part.reverted, 0),
                mismatchCount: parts.reduce((sum, part) => sum + part.mismatchCount, 0),
                mismatches: parts.flatMap((part) => part.mismatches),
                silentChanges: parts.flatMap((part) => part.silentChanges),
                operations,
                seconds: (Date.now() - started) / 1000,
            };
            printSummary(mode, merged.modes[mode]);
        }
        return merged;
    } finally {
        fs.rmSync(directory, { force: true, recursive: true });
    }
}

async function main() {
    const options = parseArguments(process.argv);
    const { buildQrvmHost } = require("./lib/qrvm-host");
    const host = buildQrvmHost({ log: options.shard ? () => {} : console.log });
    if (options.selfTest) {
        if (!selfTest(host, options)) process.exitCode = 1;
        return;
    }
    let report;
    if (options.jobs > 1 && options.replay === null && !options.shard) {
        report = await runSharded(options);
    } else {
        // --mutation plants one oracle bug to demonstrate the failure report.
        if (options.mutation) setMutation(options.mutation);
        const setup = modelSetup();
        report = {
            profile: options.profile,
            seed: options.seed,
            length: options.length,
            observations: OBSERVATIONS.length,
            shard: options.shard,
            modes: {},
        };
        for (const mode of options.modes) {
            report.modes[mode] = runMode(host, setup, options, mode);
            printSummary(mode, report.modes[mode]);
        }
    }
    if (options.report) {
        fs.mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true });
        fs.writeFileSync(path.resolve(options.report), JSON.stringify(report, null, 2) + "\n");
    }
    if (options.shard) return;
    const failed = Object.values(report.modes).some(
        (summary) => summary.mismatchCount > 0 || summary.silentChanges.length > 0
    );
    if (failed) {
        console.error("QNS fuzz found model mismatches.");
        process.exitCode = 1;
    } else {
        console.log("QNS fuzz passed: the VM matched the reference model at every step.");
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    PROFILES,
    compareResult,
    describeStep,
    modelSetup,
    parseArguments,
    replayModel,
    runSequences,
    stepCommand,
};
