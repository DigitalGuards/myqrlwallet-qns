// Bytecode for each codegen mode the fuzzer exercises. "via-ir-optimized" is
// the deployed configuration and uses the verified build/hyperion artifacts
// from npm run compile. The other modes compile the same sources with the
// pinned compiler through standard JSON.
const path = require("node:path");
const { verifyArtifactManifest } = require("../hyperionArtifacts");
const { ARTIFACT_NAMES, loadArtifacts } = require("./world");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const MODES = Object.freeze({
    "via-ir-optimized": { viaIR: true, optimize: true, deployed: true },
    "via-ir": { viaIR: true, optimize: false },
    "legacy-optimized": { viaIR: false, optimize: true },
    legacy: { viaIR: false, optimize: false },
});

function prepareArtifacts(mode) {
    const settings = MODES[mode];
    if (!settings) throw new Error(`unknown codegen mode ${mode}`);
    if (settings.deployed) {
        const artifactsDir = path.join(repoRoot, "build", "hyperion");
        verifyArtifactManifest({ hyperionRoot: path.join(repoRoot, "contracts", "hyperion"), artifactsDir });
        return loadArtifacts(artifactsDir);
    }
    const { ensureCompilerAvailable } = require("../../compile-hyperion");
    const { compileMode, sourcesIn } = require("../../lint-contracts");
    const { compilerPath } = ensureCompilerAvailable();
    const { output } = compileMode(compilerPath, sourcesIn(), { name: mode, ...settings });
    const artifacts = {};
    for (const [key, contractName] of Object.entries(ARTIFACT_NAMES)) {
        const matches = Object.values(output.contracts)
            .map((contracts) => contracts[contractName])
            .filter(Boolean);
        if (matches.length !== 1 || !matches[0].qrvm.bytecode.object) {
            throw new Error(`${mode} build has no unique bytecode for ${contractName}`);
        }
        artifacts[key] = matches[0].qrvm.bytecode.object;
    }
    return artifacts;
}

module.exports = { MODES, prepareArtifacts };
