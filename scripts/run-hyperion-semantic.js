const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyArtifactManifest } = require("./lib/hyperionArtifacts");

const repoRoot = path.join(__dirname, "..");
const workspaceRoot = path.join(repoRoot, "..");
const hyperionRoot = path.join(workspaceRoot, "hyperion");
const qrvmoneRoot = path.join(workspaceRoot, "qrvmone");
const canonicalRoot = path.join(repoRoot, "contracts", "hyperion");
const semanticSource = path.join(
    repoRoot,
    "test",
    "hyperion",
    "semantic",
    "QNSExplicitMappingAccessors.hyp"
);
const artifactRoot = path.join(repoRoot, "build", "hyperion");

const hyptestBinary =
    process.env.HYPERION_HYPTEST || path.join(hyperionRoot, "build", "test", "hyptest");
const qrvmoneLibrary =
    process.env.QRVMONE_LIBRARY ||
    path.join(qrvmoneRoot, "build", "lib", "libqrvmone.so.0.11.0");

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

function createTestTree() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qns-hyptest-"));
    const semanticRoot = path.join(
        temporaryRoot,
        "libhyperion",
        "semanticTests",
        "qns"
    );
    const externalRoot = path.join(semanticRoot, "_canonical");
    fs.mkdirSync(semanticRoot, { recursive: true });
    linkStandardSuites(temporaryRoot);
    fs.cpSync(canonicalRoot, externalRoot, { recursive: true });

    const legacySource = fs.readFileSync(semanticSource, "utf8");
    assert.match(legacySource, /compileViaYul: false/);
    fs.writeFileSync(path.join(semanticRoot, "QNSExplicitMappingAccessors.hyp"), legacySource);
    fs.writeFileSync(
        path.join(semanticRoot, "QNSExplicitMappingAccessorsViaIR.hyp"),
        legacySource.replace("compileViaYul: false", "compileViaYul: true")
    );
    return temporaryRoot;
}

function runSemanticMode(testRoot, viaIR, optimize) {
    const codegenLabel = viaIR ? "via-IR" : "legacy";
    const optimizerLabel = optimize ? "optimized" : "default";
    const suite = viaIR
        ? "semanticTests/qns/QNSExplicitMappingAccessorsViaIR"
        : "semanticTests/qns/QNSExplicitMappingAccessors";
    console.log(`Running QNS mapping accessors with ${optimizerLabel} ${codegenLabel} codegen...`);

    const customArguments = ["--vm", qrvmoneLibrary, "--testpath", testRoot, "--no-smt"];
    if (optimize) customArguments.push("--optimize");
    const result = spawnSync(
        hyptestBinary,
        [
            `--run_test=${suite}`,
            "--no_color_output",
            "--log_level=message",
            "--report_level=short",
            "--",
            ...customArguments,
        ],
        {
            cwd: hyperionRoot,
            env: process.env,
            stdio: "inherit",
        }
    );
    if (result.error) throw result.error;
    assert.equal(
        result.status,
        0,
        `QNS mapping accessor regression failed with ${optimizerLabel} ${codegenLabel} codegen`
    );
}

function main() {
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
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

module.exports = {
    createTestTree,
    requireExplicitProductionAccessors,
    requireProductionAbi,
    requireSemanticToolchain,
    runSemanticMode,
};
