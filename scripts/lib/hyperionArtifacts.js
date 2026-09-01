const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_SCHEMA_VERSION = 2;
const QRL2_PRECOMPILE_SET = "qrl2-pq-v1";
const EXPECTED_TARGET = Object.freeze({
    name: QRL2_PRECOMPILE_SET,
    activation: "genesis",
    abiWordBytes: 64,
    mldsa87: Object.freeze({ slot: 3, digestBytes: 64 }),
    shake256: Object.freeze({ slot: 6, outputBytes: 64 }),
});

function sha256Bytes(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
    return sha256Bytes(fs.readFileSync(filePath));
}

function listHyperionSources(rootDir) {
    const sources = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const absolute = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error(`Hyperion source tree contains a symbolic link: ${absolute}`);
            }
            if (entry.isDirectory()) {
                visit(absolute);
            } else if (entry.isFile() && entry.name.endsWith(".hyp")) {
                sources.push(path.relative(rootDir, absolute).split(path.sep).join("/"));
            }
        }
    };
    visit(rootDir);
    sources.sort();
    if (sources.length === 0) {
        throw new Error(`No Hyperion sources found under ${rootDir}`);
    }
    return sources;
}

function hashHyperionSourceTree(rootDir) {
    const hash = crypto.createHash("sha256");
    for (const relativePath of listHyperionSources(rootDir)) {
        hash.update(relativePath, "utf8");
        hash.update(Buffer.from([0]));
        hash.update(fs.readFileSync(path.join(rootDir, relativePath)));
        hash.update(Buffer.from([0]));
    }
    return hash.digest("hex");
}

function resolveCompilerPath(command) {
    const candidates = [];
    if (path.isAbsolute(command) || command.includes(path.sep)) {
        candidates.push(path.resolve(command));
    } else {
        for (const dir of (process.env.PATH || "").split(path.delimiter)) {
            if (dir) candidates.push(path.join(dir, command));
        }
    }
    for (const candidate of candidates) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return fs.realpathSync(candidate);
        } catch {
            // Continue through PATH candidates.
        }
    }
    throw new Error(`Hyperion compiler not found or not executable: ${command}`);
}

function parseCompilerVersion(versionOutput) {
    const versionLine = versionOutput
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("Version:"));
    if (!versionLine) {
        throw new Error("hypc --version did not report a Version line");
    }
    const version = versionLine.replace(/^Version:\s*/, "");
    if (!version || version.toLowerCase() === "unknown") {
        throw new Error("hypc reported an unknown compiler version");
    }
    return version;
}

function validateArtifactFileName(fileName, suffix) {
    if (
        typeof fileName !== "string" ||
        path.basename(fileName) !== fileName ||
        !fileName.endsWith(suffix)
    ) {
        throw new Error(`Invalid Hyperion artifact file name: ${String(fileName)}`);
    }
}

function resolveSourcePath(rootDir, relativePath) {
    if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
        throw new Error(`Invalid Hyperion source path: ${String(relativePath)}`);
    }
    const absolute = path.resolve(rootDir, relativePath);
    const relative = path.relative(rootDir, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.endsWith(".hyp")) {
        throw new Error(`Hyperion source path escapes the source tree: ${relativePath}`);
    }
    return absolute;
}

function validateTarget(target) {
    if (
        target?.name !== EXPECTED_TARGET.name ||
        target?.activation !== EXPECTED_TARGET.activation ||
        target?.abiWordBytes !== EXPECTED_TARGET.abiWordBytes ||
        target?.mldsa87?.slot !== EXPECTED_TARGET.mldsa87.slot ||
        target?.mldsa87?.digestBytes !== EXPECTED_TARGET.mldsa87.digestBytes ||
        target?.shake256?.slot !== EXPECTED_TARGET.shake256.slot ||
        target?.shake256?.outputBytes !== EXPECTED_TARGET.shake256.outputBytes
    ) {
        throw new Error(`Artifact manifest does not target ${QRL2_PRECOMPILE_SET}`);
    }
}

function createArtifactManifest({
    compilerPath,
    compilerVersion,
    hyperionRoot,
    artifactsDir,
    contracts,
}) {
    const resolvedCompilerPath = fs.realpathSync(compilerPath);
    const entries = contracts.map((entry) => {
        validateArtifactFileName(entry.abiFile, ".abi");
        validateArtifactFileName(entry.binFile, ".bin");
        const sourcePath = resolveSourcePath(hyperionRoot, entry.sourceFile);
        const abiPath = path.join(artifactsDir, entry.abiFile);
        const binPath = path.join(artifactsDir, entry.binFile);
        return {
            ...entry,
            sourceSha256: sha256File(sourcePath),
            abiSha256: sha256File(abiPath),
            binSha256: sha256File(binPath),
        };
    });
    return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        target: EXPECTED_TARGET,
        compiler: {
            path: resolvedCompilerPath,
            version: compilerVersion,
            sha256: sha256File(resolvedCompilerPath),
        },
        sourceTreeSha256: hashHyperionSourceTree(hyperionRoot),
        settings: {
            optimizer: true,
            optimizerRuns: 200,
        },
        generatedAt: new Date().toISOString(),
        contracts: entries,
    };
}

function verifyArtifactManifest({ hyperionRoot, artifactsDir }) {
    const manifestPath = path.join(artifactsDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Hyperion artifact manifest missing: ${manifestPath}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
        throw new Error(
            `Unsupported Hyperion artifact manifest schema: ${String(manifest.schemaVersion)}`
        );
    }
    validateTarget(manifest.target);
    if (!manifest.compiler || typeof manifest.compiler.path !== "string") {
        throw new Error("Artifact manifest is missing compiler provenance");
    }
    if (!manifest.compiler.version || manifest.compiler.version === "unknown") {
        throw new Error("Artifact manifest has an unknown compiler version");
    }
    if (!fs.existsSync(manifest.compiler.path)) {
        throw new Error(`Manifest compiler is unavailable: ${manifest.compiler.path}`);
    }
    if (sha256File(manifest.compiler.path) !== manifest.compiler.sha256) {
        throw new Error("Manifest compiler binary hash mismatch");
    }
    if (hashHyperionSourceTree(hyperionRoot) !== manifest.sourceTreeSha256) {
        throw new Error("Hyperion source tree does not match the artifact manifest");
    }
    if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
        throw new Error("Artifact manifest has no contracts");
    }

    const names = new Set();
    for (const entry of manifest.contracts) {
        if (!entry || typeof entry.contractName !== "string" || names.has(entry.contractName)) {
            throw new Error(`Invalid or duplicate manifest contract: ${String(entry?.contractName)}`);
        }
        names.add(entry.contractName);
        validateArtifactFileName(entry.abiFile, ".abi");
        validateArtifactFileName(entry.binFile, ".bin");
        const sourcePath = resolveSourcePath(hyperionRoot, entry.sourceFile);
        const abiPath = path.join(artifactsDir, entry.abiFile);
        const binPath = path.join(artifactsDir, entry.binFile);
        for (const [label, filePath, expectedHash] of [
            ["source", sourcePath, entry.sourceSha256],
            ["ABI", abiPath, entry.abiSha256],
            ["bytecode", binPath, entry.binSha256],
        ]) {
            if (!fs.existsSync(filePath)) {
                throw new Error(`Manifest ${label} file is missing for ${entry.contractName}`);
            }
            if (sha256File(filePath) !== expectedHash) {
                throw new Error(`Manifest ${label} hash mismatch for ${entry.contractName}`);
            }
        }
        const abi = JSON.parse(fs.readFileSync(abiPath, "utf8"));
        if (!Array.isArray(abi)) {
            throw new Error(`Manifest ABI is not an array for ${entry.contractName}`);
        }
        const bytecode = fs.readFileSync(binPath, "utf8").trim();
        if (!/^(?:[0-9a-fA-F]{2})+$/.test(bytecode)) {
            throw new Error(`Manifest bytecode is empty or malformed for ${entry.contractName}`);
        }
    }
    return manifest;
}

function validateDeploymentTarget(config) {
    if (config?.qrl2PrecompileSet !== QRL2_PRECOMPILE_SET) {
        throw new Error(
            `Deployment config must set qrl2PrecompileSet to ${QRL2_PRECOMPILE_SET}`
        );
    }
}

module.exports = {
    EXPECTED_TARGET,
    MANIFEST_SCHEMA_VERSION,
    QRL2_PRECOMPILE_SET,
    createArtifactManifest,
    hashHyperionSourceTree,
    parseCompilerVersion,
    resolveCompilerPath,
    sha256File,
    validateDeploymentTarget,
    verifyArtifactManifest,
};
