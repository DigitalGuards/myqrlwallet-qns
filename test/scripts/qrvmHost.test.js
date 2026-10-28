const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { patchHostSource, splitWords } = require("../../scripts/lib/qrvm-host");
const { verifyFrame } = require("../../scripts/lib/mldsa-host");
const {
    CryptoBytes,
    CryptoPublicKeyBytes,
    CryptoSecretKeyBytes,
    cryptoSignKeypair,
    cryptoSignSignatureDeterministic,
} = require("@theqrl/mldsa87");

const HOST = [
    "#include <test/QRVMHost.h>",
    "",
    "qrvmc::Result QRVMHost::call(qrvmc_message const& _message) noexcept",
    "{",
    "\tauto const stateBackup = accounts;",
    "\tqrvmc::Result result = run();",
    "\tif (result.status_code != QRVMC_SUCCESS)",
    "\t\taccounts = stateBackup;",
    "",
    "\treturn result;",
    "}",
    "qrvmc::Result QRVMHost::precompileMLDSA87Verify(qrvmc_message const& _message) noexcept",
    "{",
    "\treturn fixture();",
    "}",
    "",
    "qrvmc::Result QRVMHost::precompileGeneric(qrvmc_message const& _message) noexcept",
    "{",
    "}",
    "",
].join("\n");
const ADAPTER = "qrvmc::Result QRVMHost::precompileMLDSA87Verify(qrvmc_message const& _message) noexcept\n{\n\treturn adapter();\n}\n";

test("the host patch swaps the ML-DSA fixture and rolls back logs of failed frames", () => {
    const patched = patchHostSource(HOST, ADAPTER);
    assert.match(patched, /#include <sys\/un\.h>/);
    assert.match(patched, /return adapter\(\);/);
    assert.doesNotMatch(patched, /return fixture\(\);/);
    assert.match(patched, /auto const logCheckpoint = recorded_logs\.size\(\);/);
    assert.match(patched, /accounts = stateBackup;\n\t\trecorded_logs\.resize\(logCheckpoint\);/);
    assert.match(patched, /QRVMHost::precompileGeneric/);
});

test("the host patch refuses a host whose anchors moved", () => {
    assert.throws(() => patchHostSource(HOST.replace("\tauto const stateBackup = accounts;\n", ""), ADAPTER), /exactly once/);
    assert.throws(() => patchHostSource(HOST + HOST, ADAPTER), /exactly once/);
});

test("CMake word splitting keeps quoted words", () => {
    assert.deepEqual(splitWords(' -O3  "-I/a b" -DX=1 '), ["-O3", "-I/a b", "-DX=1"]);
});

test("the slot 3 verifier accepts only a valid raw frame", () => {
    const publicKey = new Uint8Array(CryptoPublicKeyBytes);
    const secretKey = new Uint8Array(CryptoSecretKeyBytes);
    cryptoSignKeypair(crypto.createHash("sha256").update("qrvm-host-test").digest(), publicKey, secretKey);
    const digest = crypto.createHash("shake256", { outputLength: 64 }).update("frame").digest();
    const context = Buffer.from("QNS-SIGN-v1");
    const signature = new Uint8Array(CryptoBytes);
    cryptoSignSignatureDeterministic(signature, digest, secretKey, context);
    const frame = (sig = signature, ctx = context, pk = publicKey) =>
        Buffer.concat([digest, Buffer.from(pk), Buffer.from(sig), Buffer.from([ctx.length]), ctx]);
    assert.equal(verifyFrame(frame()), true);
    const tampered = Buffer.from(signature);
    tampered[7] ^= 0x80;
    assert.equal(verifyFrame(frame(tampered)), false);
    assert.equal(verifyFrame(frame(signature, Buffer.from("QNS-SIGN-v2"))), false);
    assert.equal(verifyFrame(Buffer.from([0])), false, "Hyperion's one-byte invalid-length frame");
    assert.equal(verifyFrame(frame().subarray(0, 7000)), false);
    assert.equal(verifyFrame(Buffer.concat([frame(), Buffer.from([0])])), false);
});
