// Compile the synced Hyperion sources with hypc.
// Walks contracts/hyperion/ and compiles each deployable top-level contract,
// emitting ABI + bytecode to build/hyperion/ with a manifest.json.
//
// Adapted from ../../QuantaPool/scripts/compile-hyperion.js (GPL-3.0).
// Differences: walks nested dirs and supports a DEPLOYABLE allowlist so we
// skip interface-only / abstract files.

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const { syncHyperionSources } = require("./sync-hyperion");

const repoRoot = path.join(__dirname, "..");
const hyperionRoot = path.join(repoRoot, "contracts", "hyperion");
const artifactsDir = path.join(repoRoot, "build", "hyperion");
const compilerBinary = process.env.HYPERION_COMPILER || process.env.HYPC_BIN || "hypc";

// Top-level deployable contracts (relative paths under contracts/hyperion/).
// Interfaces/abstract files compile as transitive deps but are not listed here.
const DEPLOYABLE = [
    "vendored/registry/ENSRegistry.hyp",
    "vendored/root/Root.hyp",
    "vendored/reverseRegistrar/ReverseRegistrar.hyp",
    "registry/FIFSQRLRegistrar.hyp",
    "resolvers/QRLPublicResolver.hyp",
];

function ensureCompilerAvailable() {
    const result = spawnSync(compilerBinary, ["--version"], { encoding: "utf8" });
    if (result.error && result.error.code === "ENOENT") {
        throw new Error(
            `Hyperion compiler not found: ${compilerBinary}. ` +
                "Install hypc or set HYPERION_COMPILER=/path/to/hypc."
        );
    }
    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || "hypc execution failed").trim());
    }
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
    // Last contract declared in the file wins — matches QuantaPool behaviour.
    return matches[matches.length - 1][1];
}

function compileOne(relHypPath) {
    const sourcePath = path.join(hyperionRoot, relHypPath);
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Missing ${relHypPath} — run sync-hyperion first.`);
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
    syncHyperionSources();
    ensureCompilerAvailable();
    clearArtifactsDir();

    const entries = DEPLOYABLE.map(compileOne);

    const manifest = {
        compiler: compilerBinary,
        generatedAt: new Date().toISOString(),
        contracts: entries,
    };
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
