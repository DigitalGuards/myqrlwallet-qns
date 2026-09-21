const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    HYPERION_CODEGEN_MODE,
    QRL2_PRECOMPILE_SET,
    compilerCodegenArgs,
    createArtifactManifest,
    parseCompilerVersion,
    sha256File,
    validateDeploymentTarget,
    verifyPinnedCompiler,
    verifyArtifactManifest,
} = require("../../scripts/lib/hyperionArtifacts");
const {
    assertQrl2PQPrecompileTarget,
    requireHexBytes,
} = require("../../scripts/lib/qrl2Target");

function createFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qns-artifacts-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const hyperionRoot = path.join(root, "contracts", "hyperion");
    const artifactsDir = path.join(root, "build", "hyperion");
    fs.mkdirSync(hyperionRoot, { recursive: true });
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(hyperionRoot, "Example.hyp"), "contract Example {}\n");
    fs.writeFileSync(path.join(artifactsDir, "Example.abi"), "[]\n");
    fs.writeFileSync(path.join(artifactsDir, "Example.bin"), "00\n");
    const compilerPath = path.join(root, "hypc");
    fs.writeFileSync(compilerPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(compilerPath, 0o700);
    const compilerVersion = "0.2.0+commit.12345678.Linux.g++";
    const compilerSha256 = sha256File(compilerPath);
    const toolchainConfigPath = path.join(root, "hyperion-toolchain.json");
    fs.writeFileSync(
        toolchainConfigPath,
        `${JSON.stringify(
            {
                hyperionCommit: "1234567890abcdef1234567890abcdef12345678",
                compilerVersion,
                compilerSha256,
            },
            null,
            2
        )}\n`
    );

    const manifest = createArtifactManifest({
        compilerPath,
        compilerVersion,
        hyperionRoot,
        artifactsDir,
        codegenMode: HYPERION_CODEGEN_MODE,
        contracts: [
            {
                sourceFile: "Example.hyp",
                contractName: "Example",
                abiFile: "Example.abi",
                binFile: "Example.bin",
            },
        ],
    });
    fs.writeFileSync(
        path.join(artifactsDir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`
    );
    return {
        artifactsDir,
        compilerPath,
        compilerSha256,
        compilerVersion,
        hyperionRoot,
        toolchainConfigPath,
    };
}

test("verifies compiler, source and artifact provenance", (t) => {
    const fixture = createFixture(t);
    const manifest = verifyArtifactManifest(fixture);
    assert.equal(manifest.target.name, QRL2_PRECOMPILE_SET);
    assert.equal(manifest.settings.codegenMode, HYPERION_CODEGEN_MODE);
    assert.equal(manifest.settings.viaIR, true);
    assert.equal(manifest.contracts[0].contractName, "Example");
});

test("requires the explicit via-IR codegen mode", (t) => {
    assert.deepEqual(compilerCodegenArgs(HYPERION_CODEGEN_MODE), ["--via-ir"]);
    assert.throws(() => compilerCodegenArgs("legacy"), /Unsupported Hyperion codegen mode/);

    const fixture = createFixture(t);
    const manifestPath = path.join(fixture.artifactsDir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    for (const settings of [
        { ...manifest.settings, codegenMode: "legacy", viaIR: false },
        { ...manifest.settings, viaIR: false },
        { ...manifest.settings, codegenMode: undefined },
    ]) {
        fs.writeFileSync(
            manifestPath,
            `${JSON.stringify({ ...manifest, settings }, null, 2)}\n`
        );
        assert.throws(() => verifyArtifactManifest(fixture), /must use Hyperion via-ir/);
    }
});

test("rejects artifact and source changes after compilation", async (t) => {
    await t.test("artifact hash", (t) => {
        const fixture = createFixture(t);
        fs.appendFileSync(path.join(fixture.artifactsDir, "Example.abi"), " \n");
        assert.throws(() => verifyArtifactManifest(fixture), /ABI hash mismatch/);
    });
    await t.test("source tree hash", (t) => {
        const fixture = createFixture(t);
        fs.appendFileSync(path.join(fixture.hyperionRoot, "Example.hyp"), "// changed\n");
        assert.throws(() => verifyArtifactManifest(fixture), /source tree/);
    });
});

test("requires an explicit QRL2 precompile target", () => {
    assert.doesNotThrow(() =>
        validateDeploymentTarget({ qrl2PrecompileSet: QRL2_PRECOMPILE_SET })
    );
    assert.throws(() => validateDeploymentTarget({}), /qrl2PrecompileSet/);
    assert.throws(
        () => validateDeploymentTarget({ qrl2PrecompileSet: "candidate-layout" }),
        /qrl2PrecompileSet/
    );
});

test("rejects unknown compiler version output", () => {
    assert.equal(
        parseCompilerVersion("hypc\nVersion: 0.2.0+commit.12345678.Linux.g++\n"),
        "0.2.0+commit.12345678.Linux.g++"
    );
    assert.throws(() => parseCompilerVersion("hypc\n"), /Version line/);
    assert.throws(() => parseCompilerVersion("Version: unknown\n"), /unknown/);
});

test("rejects an unreviewed compiler version or binary", (t) => {
    const fixture = createFixture(t);
    const toolchain = {
        compilerVersion: fixture.compilerVersion,
        compilerSha256: fixture.compilerSha256,
    };

    assert.equal(
        verifyPinnedCompiler({
            compilerPath: fixture.compilerPath,
            compilerVersion: fixture.compilerVersion,
            toolchain,
        }),
        fixture.compilerSha256
    );
    assert.throws(
        () =>
            verifyPinnedCompiler({
                compilerPath: fixture.compilerPath,
                compilerVersion: "0.2.0-develop.2026.4.13+commit.d5d1b977.Linux.g++",
                toolchain,
            }),
        /Unreviewed Hyperion compiler version/
    );
    assert.throws(
        () =>
            verifyPinnedCompiler({
                compilerPath: fixture.compilerPath,
                compilerVersion: fixture.compilerVersion,
                toolchain: { ...toolchain, compilerSha256: "00".repeat(32) },
            }),
        /Unreviewed Hyperion compiler binary/
    );
});

test("rejects manifests produced by an unreviewed compiler", async (t) => {
    await t.test("version", (t) => {
        const fixture = createFixture(t);
        const manifestPath = path.join(fixture.artifactsDir, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.compiler.version =
            "0.2.0-develop.2026.4.13+commit.d5d1b977.Linux.g++";
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        assert.throws(
            () => verifyArtifactManifest(fixture),
            /compiler version is not the reviewed QNS toolchain/
        );
    });

    await t.test("binary hash", (t) => {
        const fixture = createFixture(t);
        const manifestPath = path.join(fixture.artifactsDir, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.compiler.sha256 = "00".repeat(32);
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        assert.throws(
            () => verifyArtifactManifest(fixture),
            /compiler binary is not the reviewed QNS toolchain/
        );
    });
});

test("live target probe checks SHAKE256 slot 6 and the 64-byte ML-DSA-87 slot 3 frame", async () => {
    const calls = [];
    const web3 = {
        qrl: {
            async call({ to, data }, block) {
                calls.push({ to, data, block });
                if (to.endsWith("06")) {
                    return `0x${crypto
                        .createHash("shake256", { outputLength: 64 })
                        .update(Buffer.from(data.slice(2), "hex"))
                        .digest("hex")}`;
                }
                if (to.endsWith("03")) return `0x${"00".repeat(63)}01`;
                throw new Error(`unexpected target ${to}`);
            },
        },
    };

    await assertQrl2PQPrecompileTarget(web3);
    assert.equal(calls.length, 3);
    assert.equal((calls[2].data.length - 2) / 2, 64 + 2592 + 4627 + 1 + 11);
    assert.ok(calls.every((call) => call.block === "latest"));
});

test("target probe rejects malformed RPC hex", () => {
    for (const value of [null, "0x0", "0xgg", "deadbeef"]) {
        assert.throws(() => requireHexBytes(value, "probe"), /malformed hex/);
    }
});
