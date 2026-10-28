// Builds the worktree-local test host used by the QNS semantic suites and the
// stateful fuzzer. Nothing is written into the Hyperion toolchain tree: the
// pinned test/QRVMHost.cpp is copied, patched and compiled under
// build/evidence/host/, then linked with the toolchain's existing hyptest
// objects and static libraries.
//
// Patches applied to the copy:
//   1. The ML-DSA-87 slot 3 fixture is replaced by test/hyperion/host/mldsa.inc,
//      which verifies the raw precompile frame with @theqrl/mldsa87.
//   2. A failed call frame drops the logs it emitted, as on a real chain. The
//      upstream test host restores account state on failure but keeps logs.
// Outputs: a patched hyptest and the qns-qrvm-driver used by the fuzzer.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ensureCompilerAvailable } = require("../compile-hyperion");

const repoRoot = path.resolve(__dirname, "..", "..");
const evidenceRoot = path.join(repoRoot, "build", "evidence");
const hostRoot = path.join(evidenceRoot, "host");
const hyperionRoot = path.resolve(
    process.env.HYPERION_SOURCE_DIR || path.join(repoRoot, "..", "hyperion")
);
const stockRunner = path.resolve(
    process.env.HYPERION_HYPTEST || path.join(hyperionRoot, "build", "test", "hyptest")
);
const vmLibrary = path.resolve(
    process.env.QRVMONE_LIBRARY ||
        path.join(repoRoot, "..", "qrvmone", "build", "lib", "libqrvmone.so")
);

// Reviewed upstream host sources (Hyperion 302c8805). A different host must be
// reviewed against both patches before these pins move.
const REVIEWED_HOST_SOURCES = {
    "test/QRVMHost.cpp": "441b08f07c2edc18c008d8dd5cb75728362514c8262b6ded0a0a424c026313ce",
    "test/QRVMHost.h": "d29b3bb8e777a4b67a4a1452f15ca1c3e05ce76d3117c9072459f4a550ac8824",
};

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function replaceOnce(source, needle, replacement, label) {
    const first = source.indexOf(needle);
    if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
        throw new Error(`Host patch anchor must occur exactly once: ${label}`);
    }
    return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function patchHostSource(source, adapter) {
    let patched = replaceOnce(
        source,
        "#include <test/QRVMHost.h>\n",
        "#include <test/QRVMHost.h>\n\n#include <sys/socket.h>\n#include <sys/un.h>\n#include <unistd.h>\n" +
            "#include <cstdlib>\n#include <cstring>\n#include <iostream>\n",
        "includes"
    );
    const start = patched.indexOf("qrvmc::Result QRVMHost::precompileMLDSA87Verify(");
    const end = patched.indexOf("qrvmc::Result QRVMHost::precompileGeneric(", start);
    if (start < 0 || end < 0) throw new Error("Host patch anchor missing: ML-DSA-87 fixture");
    patched = patched.slice(0, start) + adapter.trimEnd() + "\n\n" + patched.slice(end);
    patched = replaceOnce(
        patched,
        "\tauto const stateBackup = accounts;\n",
        "\tauto const stateBackup = accounts;\n\tauto const logCheckpoint = recorded_logs.size();\n",
        "log checkpoint"
    );
    patched = replaceOnce(
        patched,
        "\tif (result.status_code != QRVMC_SUCCESS)\n\t\taccounts = stateBackup;\n",
        "\tif (result.status_code != QRVMC_SUCCESS)\n\t{\n\t\taccounts = stateBackup;\n" +
            "\t\trecorded_logs.resize(logCheckpoint);\n\t}\n",
        "log rollback"
    );
    return patched;
}

// CMake writes flags.make and link.txt as plain space-separated words. Quotes
// are honoured for completeness.
function splitWords(text) {
    const words = [];
    for (const match of text.trim().matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
        words.push(match[1] ?? match[2] ?? match[3]);
    }
    return words;
}

function readBuildRecipe(buildRoot) {
    const flagsText = fs.readFileSync(path.join(buildRoot, "CMakeFiles/hyptest.dir/flags.make"), "utf8");
    const linkText = fs.readFileSync(path.join(buildRoot, "CMakeFiles/hyptest.dir/link.txt"), "utf8");
    const flags = ["CXX_DEFINES", "CXX_INCLUDES", "CXX_FLAGS"].flatMap((key) => {
        const match = flagsText.match(new RegExp(`^${key} = (.*)$`, "m"));
        if (!match) throw new Error(`hyptest flags.make is missing ${key}`);
        return splitWords(match[1]);
    });
    const link = splitWords(linkText);
    return { flagsText, linkText, flags, link };
}

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${path.basename(command)} failed:\n${result.stderr || result.stdout}`);
    }
}

function requireToolchain() {
    for (const [label, filePath] of [
        ["Hyperion semantic runner", stockRunner],
        ["qrvmone library", vmLibrary],
    ]) {
        if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
    }
    for (const [relative, expected] of Object.entries(REVIEWED_HOST_SOURCES)) {
        const actual = sha256(fs.readFileSync(path.join(hyperionRoot, relative)));
        if (actual !== expected) {
            throw new Error(`Unreviewed ${relative} (${actual}); review the QNS host patches first`);
        }
    }
}

// Returns { hyptest, driver, vm }. Rebuilds only when an input changed.
function buildQrvmHost({ log = console.log } = {}) {
    ensureCompilerAvailable();
    requireToolchain();
    const buildRoot = path.dirname(stockRunner);
    const recipe = readBuildRecipe(buildRoot);
    const hostSource = fs.readFileSync(path.join(hyperionRoot, "test/QRVMHost.cpp"), "utf8");
    const adapter = fs.readFileSync(path.join(repoRoot, "test/hyperion/host/mldsa.inc"), "utf8");
    const driverSource = fs.readFileSync(path.join(repoRoot, "test/hyperion/host/qrvm-driver.cpp"), "utf8");
    const patched = patchHostSource(hostSource, adapter);

    const outputs = {
        hyptest: path.join(hostRoot, "hyptest"),
        driver: path.join(hostRoot, "qns-qrvm-driver"),
        vm: vmLibrary,
    };
    const identity = sha256(
        [patched, driverSource, recipe.flagsText, recipe.linkText, sha256(fs.readFileSync(stockRunner))].join("\0")
    );
    const stamp = path.join(hostRoot, "identity");
    if (
        fs.existsSync(outputs.hyptest) &&
        fs.existsSync(outputs.driver) &&
        fs.existsSync(stamp) &&
        fs.readFileSync(stamp, "utf8") === identity
    ) {
        return outputs;
    }

    fs.mkdirSync(hostRoot, { recursive: true });
    fs.rmSync(stamp, { force: true });
    const hostCopy = path.join(hostRoot, "QRVMHost.cpp");
    const driverCopy = path.join(hostRoot, "qrvm-driver.cpp");
    fs.writeFileSync(hostCopy, patched);
    fs.writeFileSync(driverCopy, driverSource);
    const compiler = recipe.link[0];
    const hostObject = path.join(hostRoot, "QRVMHost.cpp.o");
    const driverObject = path.join(hostRoot, "qrvm-driver.cpp.o");
    log("Building the worktree QRVM host (real ML-DSA-87 adapter, reverted frames drop logs)...");
    run(compiler, [...recipe.flags, "-c", hostCopy, "-o", hostObject], buildRoot);
    run(compiler, [...recipe.flags, "-c", driverCopy, "-o", driverObject], buildRoot);

    // Patched hyptest: the stock link line with the host object swapped.
    const hyptestLink = recipe.link.slice(1);
    const hostIndex = hyptestLink.indexOf("CMakeFiles/hyptest.dir/QRVMHost.cpp.o");
    const outputIndex = hyptestLink.indexOf("-o");
    if (hostIndex < 0 || outputIndex < 0) throw new Error("Unexpected hyptest link recipe");
    hyptestLink[hostIndex] = hostObject;
    hyptestLink[outputIndex + 1] = outputs.hyptest;
    run(compiler, hyptestLink, buildRoot);

    // Driver: the same linker options and libraries, no hyptest objects.
    const linkWords = recipe.link.slice(1);
    const options = linkWords.slice(0, linkWords.findIndex((word) => !word.startsWith("-")));
    const libraries = linkWords.filter((word) => word.endsWith(".a") || /^-l\w+$/.test(word));
    run(compiler, [...options, driverObject, hostObject, ...libraries, "-o", outputs.driver], buildRoot);

    fs.writeFileSync(stamp, identity);
    return outputs;
}

module.exports = {
    REVIEWED_HOST_SOURCES,
    buildQrvmHost,
    evidenceRoot,
    hyperionRoot,
    patchHostSource,
    splitWords,
    stockRunner,
    vmLibrary,
};
