const crypto = require("node:crypto");

const {
    CryptoBytes,
    CryptoPublicKeyBytes,
    CryptoSecretKeyBytes,
    cryptoSignKeypair,
    cryptoSignSignature,
    zeroize,
} = require("@theqrl/mldsa87");

const CANONICAL_TRUE = `0x${"00".repeat(63)}01`;
const QNS_CONTEXT = new TextEncoder().encode("QNS-SIGN-v1");

function bytesToHex(value) {
    return `0x${Buffer.from(value).toString("hex")}`;
}

function precompileAddress(slot) {
    return `Q${slot.toString(16).padStart(128, "0")}`;
}

function requireHexBytes(value, label) {
    if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
        throw new Error(`${label} returned malformed hex data: ${String(value)}`);
    }
    return value.toLowerCase();
}

async function rawCall(web3, slot, data) {
    return requireHexBytes(
        await web3.qrl.call({ to: precompileAddress(slot), data }, "latest"),
        `precompile slot ${slot}`
    );
}

async function assertQrl2PQPrecompileTarget(web3) {
    const abc = Buffer.from("abc", "utf8");
    const expectedShake = `0x${crypto
        .createHash("shake256", { outputLength: 64 })
        .update(abc)
        .digest("hex")}`;
    const shakeResult = await rawCall(web3, 6, bytesToHex(abc));
    if (shakeResult !== expectedShake) {
        throw new Error(`QRL2 SHAKE256 slot 6 target probe failed: ${shakeResult}`);
    }

    const message = Buffer.from("QNS deployment target probe", "utf8");
    const digestHex = await rawCall(web3, 6, bytesToHex(message));
    if (digestHex.length !== 2 + 64 * 2) {
        throw new Error(`QRL2 SHAKE256 target probe returned ${digestHex.length - 2} hex digits`);
    }
    const digest = Uint8Array.from(Buffer.from(digestHex.slice(2), "hex"));
    const seed = new Uint8Array(32).fill(0x51);
    const publicKey = new Uint8Array(CryptoPublicKeyBytes);
    const secretKey = new Uint8Array(CryptoSecretKeyBytes);
    const signature = new Uint8Array(CryptoBytes);
    try {
        cryptoSignKeypair(seed, publicKey, secretKey);
        cryptoSignSignature(signature, digest, secretKey, false, QNS_CONTEXT);
        const frame = Buffer.concat([
            Buffer.from(digest),
            Buffer.from(publicKey),
            Buffer.from(signature),
            Buffer.from([QNS_CONTEXT.length]),
            Buffer.from(QNS_CONTEXT),
        ]);
        const verifyResult = await rawCall(web3, 3, bytesToHex(frame));
        if (verifyResult !== CANONICAL_TRUE) {
            throw new Error(`QRL2 ML-DSA-87 slot 3 target probe failed: ${verifyResult}`);
        }
    } finally {
        zeroize(seed);
        zeroize(secretKey);
        zeroize(signature);
    }

    return { shake256: shakeResult, mldsa87: CANONICAL_TRUE };
}

module.exports = {
    assertQrl2PQPrecompileTarget,
    precompileAddress,
    requireHexBytes,
};
