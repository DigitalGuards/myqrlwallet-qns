// Validate the QRL 2.0 cryptographic precompiles and their Hyperion wrapper.
//
// Usage:
//   QNS_CONFIG=config/local-qip55.json npm run verify:pq

const fs = require("fs");
const path = require("path");

const {
    CryptoBytes,
    CryptoPublicKeyBytes,
    CryptoSecretKeyBytes,
    cryptoSignKeypair,
    cryptoSignSignature,
    cryptoSignVerify,
    zeroize,
} = require("@theqrl/mldsa87");
const { Web3 } = require("@theqrl/web3");

const repoRoot = path.join(__dirname, "..");
const configPath = process.env.QNS_CONFIG
    ? path.resolve(repoRoot, process.env.QNS_CONFIG)
    : path.join(repoRoot, "config", "local-qip55.json");
const artifactsDir = path.join(repoRoot, "build", "hyperion");
const vectorsPath = path.join(repoRoot, "sdk", "src", "fixtures", "qns-vectors.json");
const expectedShake256 =
    "0x483366601360a8771c6863080cc4114d8db44530f8f1e1ee4f94ea37e78b5739" +
    "d5a15bef186a5386c75744c0527e1faa9f8726e462a12a4feb06bd8801e751e4";
const canonicalTrue = `0x${"00".repeat(63)}01`;
const canonicalFalse = `0x${"00".repeat(64)}`;
const emptyReturnData = "0x";

function loadJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function bytesToHex(value) {
    return `0x${Buffer.from(value).toString("hex")}`;
}

function hexToBytes(value) {
    return Uint8Array.from(Buffer.from(value.replace(/^0x/, ""), "hex"));
}

function precompileAddress(slot) {
    return `Q${slot.toString(16).padStart(128, "0")}`;
}

function toQAddress(value) {
    if (value.startsWith("Q")) return value;
    if (/^0x[0-9a-fA-F]{128}$/.test(value)) return `Q${value.slice(2)}`;
    throw new Error(`Expected a 64-byte QRL address, got ${value}`);
}

async function rawCall(web3, to, data) {
    return web3.qrl.call({ to: toQAddress(to), data }, "latest");
}

function contractMethod(abi, name) {
    const item = abi.find((entry) => entry.type === "function" && entry.name === name);
    if (!item) throw new Error(`ABI method missing: ${name}`);
    return item;
}

async function callContract(web3, address, abi, methodName, args) {
    const method = contractMethod(abi, methodName);
    const data = web3.qrl.abi.encodeFunctionCall(method, args);
    const raw = await rawCall(web3, address, data);
    return web3.qrl.abi.decodeParameter(method.outputs[0], raw);
}

async function main() {
    const config = loadJson(configPath);
    const verifierAddress = config.contracts?.QRLSignatureVerifier;
    if (!verifierAddress) {
        throw new Error(`${configPath} is missing QRLSignatureVerifier`);
    }

    const abi = loadJson(path.join(artifactsDir, "QRLSignatureVerifier.abi"));
    const web3 = new Web3(config.rpcUrl);
    const chainId = await web3.qrl.getChainId();
    if (Number(chainId) !== config.chainId) {
        throw new Error(`chainId mismatch: expected ${config.chainId}, got ${chainId}`);
    }

    // Offline parity: this script's inline frame construction must produce the
    // exact bytes pinned by the shared SDK fixture, so the three encoder
    // implementations (SDK, this script, Hyperion builtin) cannot drift apart
    // silently.
    const vectors = loadJson(vectorsPath);
    const fixtureFrame = Buffer.concat([
        Buffer.alloc(64, vectors.mldsaFrame.digestFill),
        Buffer.alloc(2592, vectors.mldsaFrame.publicKeyFill),
        Buffer.alloc(4627, vectors.mldsaFrame.signatureFill),
        Buffer.from([vectors.mldsaFrame.context.length]),
        Buffer.from(vectors.mldsaFrame.context, "ascii"),
    ]);
    if (fixtureFrame.length !== vectors.mldsaFrame.totalLength) {
        throw new Error(`fixture frame length drifted: ${fixtureFrame.length}`);
    }
    const fixtureFrameHash = web3.utils.keccak256(bytesToHex(fixtureFrame));
    if (fixtureFrameHash.toLowerCase() !== vectors.mldsaFrame.keccak256) {
        throw new Error(
            `frame encoding drifted from the shared fixture: ${fixtureFrameHash}`
        );
    }
    console.log("[1/9] shared fixture: ML-DSA frame layout parity passed");

    const abcHex = bytesToHex(new TextEncoder().encode("abc"));
    const shakeResult = await rawCall(web3, precompileAddress(6), abcHex);
    if (shakeResult.toLowerCase() !== expectedShake256) {
        throw new Error(`SHAKE256 vector mismatch: ${shakeResult}`);
    }
    console.log("[2/9] raw SHAKE256 precompile: known vector passed");

    const message = new TextEncoder().encode("QNS local integration vector");
    const digestHex = await rawCall(web3, precompileAddress(6), bytesToHex(message));
    const digest = hexToBytes(digestHex);
    const context = new TextEncoder().encode("QNS-SIGN-v1");
    const seed = new Uint8Array(32).fill(0x51);
    const publicKey = new Uint8Array(CryptoPublicKeyBytes);
    const secretKey = new Uint8Array(CryptoSecretKeyBytes);
    const signature = new Uint8Array(CryptoBytes);

    try {
        cryptoSignKeypair(seed, publicKey, secretKey);
        cryptoSignSignature(signature, digest, secretKey, false, context);
        if (!cryptoSignVerify(signature, digest, publicKey, context)) {
            throw new Error("JavaScript ML-DSA-87 vector did not verify locally");
        }

        const rawVerifyInput = bytesToHex(
            Buffer.concat([
                Buffer.from(digest),
                Buffer.from(publicKey),
                Buffer.from(signature),
                Buffer.from([context.length]),
                Buffer.from(context),
            ])
        );
        const rawVerifyResult = await rawCall(web3, precompileAddress(3), rawVerifyInput);
        if (rawVerifyResult.toLowerCase() !== canonicalTrue) {
            throw new Error(`raw ML-DSA-87 true result is not canonical: ${rawVerifyResult}`);
        }
        console.log("[3/9] raw ML-DSA-87 precompile: valid signature passed");

        const buildFrame = (frameDigest, framePublicKey, frameSignature, frameContext) =>
            bytesToHex(
                Buffer.concat([
                    Buffer.from(frameDigest),
                    Buffer.from(framePublicKey),
                    Buffer.from(frameSignature),
                    Buffer.from([frameContext.length]),
                    Buffer.from(frameContext),
                ])
            );
        const expectRejected = async (label, input) => {
            const resultHex = (await rawCall(web3, precompileAddress(3), input)).toLowerCase();
            if (resultHex !== emptyReturnData && resultHex !== canonicalFalse) {
                throw new Error(`${label} returned unexpected data: ${resultHex}`);
            }
        };

        const invalidSignature = signature.slice();
        invalidSignature[0] ^= 0x01;
        const invalidInput = bytesToHex(
            Buffer.concat([
                Buffer.from(digest),
                Buffer.from(publicKey),
                Buffer.from(invalidSignature),
                Buffer.from([context.length]),
                Buffer.from(context),
            ])
        );
        const rawInvalidResult = await rawCall(web3, precompileAddress(3), invalidInput);
        const normalizedInvalidResult = rawInvalidResult.toLowerCase();
        if (
            normalizedInvalidResult !== emptyReturnData &&
            normalizedInvalidResult !== canonicalFalse
        ) {
            throw new Error(`raw ML-DSA-87 failure returned unexpected data: ${rawInvalidResult}`);
        }
        const failureConvention =
            normalizedInvalidResult === emptyReturnData ? "empty return data" : "canonical false";
        console.log(
            `[4/9] raw ML-DSA-87 precompile: invalid signature rejected (${failureConvention})`
        );

        const mutatedDigest = digest.slice();
        mutatedDigest[0] ^= 0x01;
        await expectRejected(
            "mutated digest",
            buildFrame(mutatedDigest, publicKey, signature, context)
        );
        console.log("[5/9] raw ML-DSA-87 precompile: mutated digest rejected");

        const mutatedPublicKey = publicKey.slice();
        mutatedPublicKey[0] ^= 0x01;
        await expectRejected(
            "mutated public key",
            buildFrame(digest, mutatedPublicKey, signature, context)
        );
        console.log("[6/9] raw ML-DSA-87 precompile: mutated public key rejected");

        const emptyContext = new Uint8Array(0);
        const emptyContextSignature = new Uint8Array(CryptoBytes);
        cryptoSignSignature(emptyContextSignature, digest, secretKey, false, emptyContext);
        const emptyContextResult = await rawCall(
            web3,
            precompileAddress(3),
            buildFrame(digest, publicKey, emptyContextSignature, emptyContext)
        );
        if (emptyContextResult.toLowerCase() !== canonicalTrue) {
            throw new Error(`empty-context verification failed: ${emptyContextResult}`);
        }
        const maxContext = new Uint8Array(255).fill(0x7a);
        const maxContextSignature = new Uint8Array(CryptoBytes);
        cryptoSignSignature(maxContextSignature, digest, secretKey, false, maxContext);
        const maxContextResult = await rawCall(
            web3,
            precompileAddress(3),
            buildFrame(digest, publicKey, maxContextSignature, maxContext)
        );
        if (maxContextResult.toLowerCase() !== canonicalTrue) {
            throw new Error(`255-byte-context verification failed: ${maxContextResult}`);
        }
        await expectRejected(
            "cross-context replay (empty-context signature under QNS context)",
            buildFrame(digest, publicKey, emptyContextSignature, context)
        );
        console.log(
            "[7/9] raw ML-DSA-87 precompile: context boundaries passed (empty and 255 bytes; cross-context replay rejected)"
        );

        const wrappedDigest = await callContract(web3, verifierAddress, abi, "digest", [
            bytesToHex(message),
        ]);
        if (wrappedDigest.toLowerCase() !== digestHex.toLowerCase()) {
            throw new Error("Hyperion SHAKE256 wrapper disagrees with the raw precompile");
        }

        const wrappedValid = await callContract(web3, verifierAddress, abi, "verify", [
            bytesToHex(message),
            bytesToHex(signature),
            bytesToHex(publicKey),
        ]);
        const wrappedInvalid = await callContract(web3, verifierAddress, abi, "verify", [
            bytesToHex(message),
            bytesToHex(invalidSignature),
            bytesToHex(publicKey),
        ]);
        if (wrappedValid !== true || wrappedInvalid !== false) {
            throw new Error(
                `Hyperion verify results disagree: valid=${wrappedValid}, invalid=${wrappedInvalid}`
            );
        }
        console.log("[8/9] Hyperion QNS wrapper: digest and valid/invalid verification passed");

        const verifyDigest = await callContract(web3, verifierAddress, abi, "verifyDigest", [
            digestHex,
            bytesToHex(signature),
            bytesToHex(publicKey),
            bytesToHex(context),
        ]);
        const shortDigest = await callContract(web3, verifierAddress, abi, "verifyDigest", [
            "0x42",
            bytesToHex(signature),
            bytesToHex(publicKey),
            bytesToHex(context),
        ]);
        if (verifyDigest !== true || shortDigest !== false) {
            throw new Error(
                `Hyperion digest-boundary results disagree: valid=${verifyDigest}, short=${shortDigest}`
            );
        }
        console.log("[9/9] Hyperion QNS wrapper: exact 64-byte digest boundary passed");
    } finally {
        zeroize(seed);
        zeroize(secretKey);
    }
}

main().catch((error) => {
    console.error("PQ integration verification failed:", error.message);
    if (error.data) console.error("Data:", error.data);
    process.exit(1);
});
