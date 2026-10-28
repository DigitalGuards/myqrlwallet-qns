const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyArtifactManifest } = require("./lib/hyperionArtifacts");

const repoRoot = path.join(__dirname, "..");
const workspaceRoot = path.join(repoRoot, "..");
const hyperionRoot = process.env.HYPERION_SOURCE_DIR
    ? path.resolve(process.env.HYPERION_SOURCE_DIR)
    : path.join(workspaceRoot, "hyperion");
const qrvmoneRoot = path.join(workspaceRoot, "qrvmone");
const canonicalRoot = path.join(repoRoot, "contracts", "hyperion");
const semanticRoot = path.join(repoRoot, "test", "hyperion", "semantic");
const harnessRoot = path.join(semanticRoot, "harness");
const ACCESSOR_SUITE = "QNSExplicitMappingAccessors";
const semanticSource = path.join(semanticRoot, `${ACCESSOR_SUITE}.hyp`);
const artifactRoot = path.join(repoRoot, "build", "hyperion");

const hyptestBinary =
    process.env.HYPERION_HYPTEST || path.join(hyperionRoot, "build", "test", "hyptest");
const qrvmoneLibrary =
    process.env.QRVMONE_LIBRARY ||
    path.join(qrvmoneRoot, "build", "lib", "libqrvmone.so.0.11.0");

const MODES = [
    { viaIR: false, optimize: false, label: "default legacy" },
    { viaIR: false, optimize: true, label: "optimized legacy" },
    { viaIR: true, optimize: false, label: "default via-IR" },
    { viaIR: true, optimize: true, label: "optimized via-IR" },
];

function requireSemanticToolchain() {
    for (const [label, filePath] of [
        ["Hyperion semantic runner", hyptestBinary],
        ["qrvmone library", qrvmoneLibrary],
    ]) {
        assert.ok(fs.existsSync(filePath), `${label} is missing: ${filePath}`);
    }
    verifyArtifactManifest({ hyperionRoot: canonicalRoot, artifactsDir: artifactRoot });
}

function requireFunction(abi, contractName, functionName, inputType, outputType) {
    const matches = abi.filter(
        (entry) =>
            entry.type === "function" &&
            entry.name === functionName &&
            entry.inputs?.length === 1 &&
            entry.inputs[0].type === inputType &&
            entry.outputs?.length === 1 &&
            entry.outputs[0].type === outputType &&
            entry.stateMutability === "view"
    );
    assert.equal(
        matches.length,
        1,
        `${contractName} ABI must expose ${functionName}(${inputType}) -> ${outputType}`
    );
}

function requireProductionAbi() {
    const rootAbi = JSON.parse(fs.readFileSync(path.join(artifactRoot, "Root.abi"), "utf8"));
    const reverseAbi = JSON.parse(
        fs.readFileSync(path.join(artifactRoot, "ReverseRegistrar.abi"), "utf8")
    );
    const resolverAbi = JSON.parse(
        fs.readFileSync(path.join(artifactRoot, "QRLPublicResolver.abi"), "utf8")
    );

    requireFunction(rootAbi, "Root", "controllers", "address", "bool");
    requireFunction(rootAbi, "Root", "locked", "bytes32", "bool");
    requireFunction(reverseAbi, "ReverseRegistrar", "controllers", "address", "bool");
    requireFunction(
        resolverAbi,
        "QRLPublicResolver",
        "recordVersions",
        "bytes32",
        "uint64"
    );
}

function requireExplicitProductionAccessors() {
    const checks = [
        [
            "vendored/root/Controllable.hyp",
            /mapping\(address => bool\) private _controllers;/,
            /function controllers\(address controller\) public view returns \(bool\)/,
        ],
        [
            "vendored/root/Root.hyp",
            /mapping\(bytes32 => bool\) private _locked;/,
            /function locked\(bytes32 label\) external view returns \(bool\)/,
        ],
        [
            "vendored/resolvers/ResolverBase.hyp",
            /mapping\(bytes32 => uint64\) private _recordVersions;/,
            /function recordVersions\([\s\S]*bytes32 node[\s\S]*\) public view virtual override returns \(uint64\)/,
        ],
    ];

    for (const [relativePath, privateMapping, explicitGetter] of checks) {
        const source = fs.readFileSync(path.join(canonicalRoot, relativePath), "utf8");
        assert.match(source, privateMapping, `${relativePath} must use private mapping storage`);
        assert.match(source, explicitGetter, `${relativePath} must define an explicit typed getter`);
    }
}

function linkStandardSuites(testRoot) {
    fs.symlinkSync(path.join(hyperionRoot, "test", "libyul"), path.join(testRoot, "libyul"));
    for (const suiteDirectory of [
        "ABIJson",
        "ASTJSON",
        "astPropertyTests",
        "gasTests",
        "memoryGuardTests",
        "natspecJSON",
        "smtCheckerTests",
        "syntaxTests",
    ]) {
        fs.symlinkSync(
            path.join(hyperionRoot, "test", "libhyperion", suiteDirectory),
            path.join(testRoot, "libhyperion", suiteDirectory)
        );
    }
}

// Writes every suite twice, once per code generator. Templates receive their
// generated values (SDK vectors, ML-DSA-87 vectors) before they are written.
function createTestTree(suites = { [ACCESSOR_SUITE]: fs.readFileSync(semanticSource, "utf8") }) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qns-hyptest-"));
    const suiteRoot = path.join(temporaryRoot, "libhyperion", "semanticTests", "qns");
    fs.mkdirSync(suiteRoot, { recursive: true });
    linkStandardSuites(temporaryRoot);
    fs.cpSync(canonicalRoot, path.join(suiteRoot, "_canonical"), { recursive: true });
    fs.cpSync(harnessRoot, path.join(suiteRoot, "_harness"), { recursive: true });
    for (const [name, source] of Object.entries(suites)) {
        assert.match(source, /compileViaYul: false/, `${name} must declare compileViaYul: false`);
        assert.doesNotMatch(source, /\{\{[A-Za-z0-9_]+\}\}/, `${name} has an unfilled template value`);
        fs.writeFileSync(path.join(suiteRoot, `${name}.hyp`), source);
        fs.writeFileSync(
            path.join(suiteRoot, `${name}ViaIR.hyp`),
            source.replace("compileViaYul: false", "compileViaYul: true")
        );
    }
    return temporaryRoot;
}

function runHyptest({ binary, testRoot, filter, optimize, env = process.env, capture = false }) {
    const customArguments = ["--vm", qrvmoneLibrary, "--testpath", testRoot, "--no-smt"];
    if (optimize) customArguments.push("--optimize");
    return spawnSync(
        binary,
        [
            `--run_test=${filter}`,
            "--no_color_output",
            "--log_level=message",
            "--report_level=short",
            "--",
            ...customArguments,
        ],
        {
            cwd: hyperionRoot,
            env,
            encoding: "utf8",
            maxBuffer: 256 * 1024 * 1024,
            stdio: capture ? "pipe" : "inherit",
        }
    );
}

function runSemanticMode(testRoot, viaIR, optimize) {
    const codegenLabel = viaIR ? "via-IR" : "legacy";
    const optimizerLabel = optimize ? "optimized" : "default";
    const suite = viaIR
        ? `semanticTests/qns/${ACCESSOR_SUITE}ViaIR`
        : `semanticTests/qns/${ACCESSOR_SUITE}`;
    console.log(`Running QNS mapping accessors with ${optimizerLabel} ${codegenLabel} codegen...`);
    const result = runHyptest({ binary: hyptestBinary, testRoot, filter: suite, optimize });
    if (result.error) throw result.error;
    assert.equal(
        result.status,
        0,
        `QNS mapping accessor regression failed with ${optimizerLabel} ${codegenLabel} codegen`
    );
}

// Suites that run on the worktree host: every test/hyperion/semantic/*.hyp
// except the accessor regression, which keeps running on the stock runner.
function loadQnsSuites(only = null) {
    const { renderSemanticTemplate } = require("./lib/semantic-vectors");
    const suites = {};
    for (const file of fs.readdirSync(semanticRoot).sort()) {
        if (!file.endsWith(".hyp") || file === `${ACCESSOR_SUITE}.hyp`) continue;
        const name = file.slice(0, -".hyp".length);
        if (only && !only.includes(name)) continue;
        suites[name] = renderSemanticTemplate(fs.readFileSync(path.join(semanticRoot, file), "utf8"));
    }
    return suites;
}

function countCases(output) {
    const match = /(\d+) test cases? out of \d+ passed/.exec(output || "");
    return match ? Number(match[1]) : 0;
}

async function runQnsSuites({ only = null, modes = MODES, print = console.log } = {}) {
    const { buildQrvmHost } = require("./lib/qrvm-host");
    const { startVerifier } = require("./lib/mldsa-host");
    const suites = loadQnsSuites(only);
    const names = Object.keys(suites);
    if (names.length === 0) throw new Error("No QNS semantic suites selected");
    const host = buildQrvmHost();
    const testRoot = createTestTree(suites);
    const verifier = await startVerifier();
    const env = { ...process.env, QNS_MLDSA_SOCKET: verifier.socketPath, QNS_MLDSA_FAILURE_FORM: "empty" };
    const failures = [];
    let cases = 0;
    const runOne = (label, filter, optimize, runEnv) => {
        const result = runHyptest({ binary: host.hyptest, testRoot, filter, optimize, env: runEnv, capture: true });
        if (result.error) throw result.error;
        const passed = result.status === 0 && countCases(result.stdout + result.stderr) === 1;
        cases += passed ? 1 : 0;
        print(`  ${passed ? "pass" : "FAIL"} ${label}`);
        if (!passed) failures.push({ label, output: `${result.stdout}\n${result.stderr}` });
    };
    try {
        for (const mode of modes) {
            const suffix = mode.viaIR ? "ViaIR" : "";
            for (const name of names) {
                runOne(`${name} (${mode.label})`, `semanticTests/qns/${name}${suffix}`, mode.optimize, env);
            }
            // The verifier must also reject every negative vector when the
            // precompile reports failure as a 64-byte zero word.
            if (names.includes("QNSSignatureVerifier")) {
                runOne(
                    `QNSSignatureVerifier, zero-word failure form (${mode.label})`,
                    `semanticTests/qns/QNSSignatureVerifier${suffix}`,
                    mode.optimize,
                    { ...env, QNS_MLDSA_FAILURE_FORM: "zero" }
                );
            }
        }
        const stats = await verifier.stats();
        return { cases, failures, verifier: stats, names };
    } finally {
        verifier.stop();
        fs.rmSync(testRoot, { force: true, recursive: true });
    }
}

async function main() {
    requireSemanticToolchain();
    requireProductionAbi();
    requireExplicitProductionAccessors();

    const temporaryRoot = createTestTree();
    try {
        runSemanticMode(temporaryRoot, false, false);
        runSemanticMode(temporaryRoot, false, true);
        runSemanticMode(temporaryRoot, true, false);
        runSemanticMode(temporaryRoot, true, true);
    } finally {
        fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
    console.log(
        "Hyperion semantic gate passed: distinct Q128 and bytes32 mapping keys remained isolated under legacy and via-IR codegen."
    );

    const onlyArgument = process.argv.find((argument) => argument.startsWith("--only="));
    const only = onlyArgument ? onlyArgument.slice("--only=".length).split(",") : null;
    console.log("Running QNS contract suites on the worktree host (real ML-DSA-87 verifier)...");
    const { cases, failures, verifier, names } = await runQnsSuites({ only });
    for (const failure of failures) console.error(`\n${failure.label} failed:\n${failure.output}`);
    assert.equal(failures.length, 0, `${failures.length} QNS semantic suite run(s) failed`);
    if (names.includes("QNSSignatureVerifier")) {
        assert.ok(verifier.requests > 0 && verifier.accepted > 0, "The ML-DSA-87 verifier was not exercised");
    }
    console.log(
        `QNS semantic suites passed: ${names.length} suites, ${cases} suite runs across legacy and via-IR codegen, ` +
            `${verifier.requests} ML-DSA-87 verifications (${verifier.accepted} valid).`
    );
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = {
    MODES,
    createTestTree,
    loadQnsSuites,
    requireExplicitProductionAccessors,
    requireProductionAbi,
    requireSemanticToolchain,
    runHyptest,
    runQnsSuites,
    runSemanticMode,
};
