const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    DEFAULT_COMPILER_COMMAND,
    ensureCompilerAvailable,
} = require("../../scripts/compile-hyperion");
const { sha256File } = require("../../scripts/lib/hyperionArtifacts");
const toolchain = require("../../config/hyperion-toolchain.json");

test("defaults to the central QRL 64-byte Hyperion compiler", () => {
    assert.equal(
        DEFAULT_COMPILER_COMMAND,
        path.resolve(__dirname, "..", "..", "..", "hyperion", "build", "hypc", "hypc")
    );
});

test("compile preflight rejects the old system compiler identity", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qns-compiler-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const compilerPath = path.join(root, "hypc");
    fs.writeFileSync(
        compilerPath,
        "#!/bin/sh\nprintf '%s\\n' 'hypc, the hyperion compiler commandline interface' " +
            "'Version: 0.2.0-develop.2026.4.13+commit.d5d1b977.Linux.g++'\n"
    );
    fs.chmodSync(compilerPath, 0o700);

    assert.throws(
        () =>
            ensureCompilerAvailable({
                compilerCommand: compilerPath,
                toolchain: {
                    compilerVersion: toolchain.compilerVersion,
                    compilerSha256: sha256File(compilerPath),
                },
            }),
        /Unreviewed Hyperion compiler version/
    );
});

test("compile preflight rejects a binary hash mismatch", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qns-compiler-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const compilerPath = path.join(root, "hypc");
    const compilerVersion = toolchain.compilerVersion;
    fs.writeFileSync(
        compilerPath,
        `#!/bin/sh\nprintf '%s\\n' 'hypc' 'Version: ${compilerVersion}'\n`
    );
    fs.chmodSync(compilerPath, 0o700);

    assert.throws(
        () =>
            ensureCompilerAvailable({
                compilerCommand: compilerPath,
                toolchain: {
                    compilerVersion,
                    compilerSha256: "00".repeat(32),
                },
            }),
        /Unreviewed Hyperion compiler binary/
    );
});
