// Compile the canonical Hyperion sources with hypc.
// Walks contracts/hyperion/ and compiles each deployable top-level contract,
// emitting ABI + bytecode to build/hyperion/ with a manifest.json.
//
// Adapted from the QuantaPool Hyperion compile script (GPL-3.0).
// Differences: walks nested dirs and supports a DEPLOYABLE allowlist so we
// skip interface-only / abstract files.

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const {
    createArtifactManifest,
    parseCompilerVersion,
    resolveCompilerPath,
} = require("./lib/hyperionArtifacts");

const repoRoot = path.join(__dirname, "..");
const hyperionRoot = path.join(repoRoot, "contracts", "hyperion");
const artifactsDir = path.join(repoRoot, "build", "hyperion");
const compilerCommand = process.env.HYPERION_COMPILER || process.env.HYPC_BIN || "hypc";
let compilerBinary;

// Top-level deployable contracts (relative paths under contracts/hyperion/).
// Interfaces/abstract files compile as transitive deps but are not listed here.
const DEPLOYABLE = [
    "vendored/registry/QNSRegistry.hyp",
    "vendored/root/Root.hyp",
    "vendored/reverseRegistrar/ReverseRegistrar.hyp",
    "registry/FIFSQRLRegistrar.hyp",
    "resolvers/QRLPublicResolver.hyp",
    "crypto/QRLSignatureVerifier.hyp",
];

function ensureCompilerAvailable() {
    compilerBinary = resolveCompilerPath(compilerCommand);
    const result = spawnSync(compilerBinary, ["--version"], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || "hypc execution failed").trim());
    }
    // The compiler build determines the precompile slots baked into the
    // builtins, so artifact provenance must record exactly which hypc ran.
    const versionOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
    const compilerVersion = parseCompilerVersion(versionOutput);
    console.log(`hypc: ${compilerBinary} (${compilerVersion})`);
    return { compilerPath: compilerBinary, compilerVersion };
}

function clearArtifactsDir() {
    fs.mkdirSync(artifactsDir, { recursive: true });
    for (const f of fs.readdirSync(artifactsDir)) {
        fs.rmSync(path.join(artifactsDir, f), { force: true, recursive: true });
    }
}

function discoverPrimaryContractName(source) {
    const matches = [
        ...source.matchAll(
            /^\s*(?:abstract\s+)?contract\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm
        ),
    ];
    if (matches.length === 0) {
        throw new Error("No contract definition found in Hyperion source.");
    }
    // Last contract declared in the file wins; this matches QuantaPool behaviour.
    return matches[matches.length - 1][1];
}

function compileOne(relHypPath) {
    const sourcePath = path.join(hyperionRoot, relHypPath);
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Missing canonical Hyperion source: ${relHypPath}`);
    }
    const source = fs.readFileSync(sourcePath, "utf8");
    const contractName = discoverPrimaryContractName(source);

    console.log(`compile ${relHypPath} -> ${contractName}`);
    execFileSync(
        compilerBinary,
        [
            "--abi",
            "--bin",
            `--base-path=${hyperionRoot}`,
            `--allow-paths=${repoRoot},${hyperionRoot}`,
            "--optimize",
            "--optimize-runs=200",
            `--output-dir=${artifactsDir}`,
            "--overwrite",
            sourcePath,
        ],
        { stdio: ["ignore", "inherit", "inherit"] }
    );

    return {
        sourceFile: relHypPath,
        contractName,
        abiFile: `${contractName}.abi`,
        binFile: `${contractName}.bin`,
    };
}

function compileAll() {
    const { compilerPath, compilerVersion } = ensureCompilerAvailable();
    clearArtifactsDir();

    const entries = DEPLOYABLE.map(compileOne);

    const manifest = createArtifactManifest({
        compilerPath,
        compilerVersion,
        hyperionRoot,
        artifactsDir,
        contracts: entries,
    });
    const manifestPath = path.join(artifactsDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`\nWrote ${manifestPath}`);
    console.log(`Compiled ${entries.length} contract(s).`);
}

if (require.main === module) {
    try {
        compileAll();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = { compileAll };
