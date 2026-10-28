// Values substituted into test/hyperion/semantic/*.hyp before hyptest runs.
// SDK values come from sdk/src/fixtures/qns-vectors.json, so the contracts
// and the SDK are held to the same known answers. ML-DSA-87 vectors are real
// keys and signatures from @theqrl/mldsa87, derived from fixed seeds so every
// run produces identical bytes.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
    CryptoBytes,
    CryptoPublicKeyBytes,
    CryptoSecretKeyBytes,
    cryptoSignKeypair,
    cryptoSignSignatureDeterministic,
    cryptoSignVerify,
} = require("@theqrl/mldsa87");

const repoRoot = path.resolve(__dirname, "..", "..");
const QNS_CONTEXT = "QNS-SIGN-v1";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const seed = (label) => crypto.createHash("sha256").update(`qns-semantic-mldsa:${label}`).digest();
const shake256 = (bytes) => crypto.createHash("shake256", { outputLength: 64 }).update(bytes).digest();

function keypair(label) {
    const publicKey = new Uint8Array(CryptoPublicKeyBytes);
    const secretKey = new Uint8Array(CryptoSecretKeyBytes);
    cryptoSignKeypair(seed(label), publicKey, secretKey);
    return { publicKey, secretKey };
}

function sign(message, secretKey, context) {
    const signature = new Uint8Array(CryptoBytes);
    cryptoSignSignatureDeterministic(signature, message, secretKey, Buffer.from(context, "utf8"));
    return signature;
}

function mldsaVectors() {
    const signer = keypair("signer");
    const other = keypair("other");
    const message = Buffer.from("QNS semantic vector: alice.qrl owns this record", "utf8");
    const digest = shake256(message);
    const valid = sign(digest, signer.secretKey, QNS_CONTEXT);
    const otherContext = sign(digest, signer.secretKey, "QNS-SIGN-v2");
    const emptyContext = sign(digest, signer.secretKey, "");
    const longContextText = "c".repeat(255);
    const longContext = sign(digest, signer.secretKey, longContextText);
    const tampered = Buffer.from(valid);
    tampered[100] ^= 0x01;
    // Self-check the vectors with the library before handing them to the VM.
    const ctx = (text) => Buffer.from(text, "utf8");
    const checks = [
        [cryptoSignVerify(valid, digest, signer.publicKey, ctx(QNS_CONTEXT)), true],
        [cryptoSignVerify(valid, digest, other.publicKey, ctx(QNS_CONTEXT)), false],
        [cryptoSignVerify(tampered, digest, signer.publicKey, ctx(QNS_CONTEXT)), false],
        [cryptoSignVerify(otherContext, digest, signer.publicKey, ctx(QNS_CONTEXT)), false],
        [cryptoSignVerify(otherContext, digest, signer.publicKey, ctx("QNS-SIGN-v2")), true],
        [cryptoSignVerify(emptyContext, digest, signer.publicKey, ctx("")), true],
        [cryptoSignVerify(longContext, digest, signer.publicKey, ctx(longContextText)), true],
    ];
    checks.forEach(([actual, expected], index) => {
        if (actual !== expected) throw new Error(`ML-DSA-87 vector self-check ${index} failed`);
    });
    return {
        MLDSA_MESSAGE: hex(message),
        MLDSA_OTHER_MESSAGE: hex(Buffer.from("QNS semantic vector: bob.qrl owns this record", "utf8")),
        MLDSA_DIGEST: hex(digest),
        MLDSA_PUBLIC_KEY: hex(signer.publicKey),
        MLDSA_OTHER_PUBLIC_KEY: hex(other.publicKey),
        MLDSA_SIGNATURE: hex(valid),
        MLDSA_SIGNATURE_OTHER_CONTEXT: hex(otherContext),
        MLDSA_SIGNATURE_EMPTY_CONTEXT: hex(emptyContext),
        MLDSA_SIGNATURE_LONG_CONTEXT: hex(longContext),
        MLDSA_SIGNATURE_TAMPERED: hex(tampered),
        MLDSA_LONG_CONTEXT: hex(Buffer.from(longContextText, "utf8")),
    };
}

function sdkVectors() {
    const fixture = JSON.parse(
        fs.readFileSync(path.join(repoRoot, "sdk", "src", "fixtures", "qns-vectors.json"), "utf8")
    );
    const strip = (value) => value.replace(/^0x/, "");
    return {
        SDK_REVERSE_ADDRESS: fixture.reverse.address,
        SDK_REVERSE_ADDRESS_HEX: fixture.reverse.address.replace(/^Q/, ""),
        SDK_REVERSE_LABEL: strip(fixture.reverse.sha3HexAddress),
        SDK_REVERSE_NODE: strip(fixture.reverse.node),
        SDK_NAMEHASH_ADDR_REVERSE: strip(fixture.namehash["addr.reverse"]),
        SDK_NAMEHASH_ALICE_QRL: strip(fixture.namehash["alice.qrl"]),
    };
}

// hyptest needs every transitively imported file declared as an external
// source. The list covers the whole contract tree and the shared harness.
function externalSources() {
    const files = [];
    const visit = (directory, prefix) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(full, `${prefix}${entry.name}/`);
            else if (entry.name.endsWith(".hyp")) files.push(`${prefix}${entry.name}`);
        }
    };
    visit(path.join(repoRoot, "contracts", "hyperion"), "_canonical/");
    visit(path.join(repoRoot, "test", "hyperion", "semantic", "harness"), "_harness/");
    return files.map((file) => `==== ExternalSource: ${file} ====`).join("\n");
}

let cached = null;
function semanticVectors() {
    cached ??= { ...sdkVectors(), ...mldsaVectors(), QNS_EXTERNAL_SOURCES: externalSources() };
    return cached;
}

function renderSemanticTemplate(source) {
    if (!/\{\{[A-Z0-9_]+\}\}/.test(source)) return source;
    const values = semanticVectors();
    return source.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
        if (!(key in values)) throw new Error(`Unknown semantic template value ${key}`);
        return values[key];
    });
}

module.exports = { QNS_CONTEXT, renderSemanticTemplate, semanticVectors };
