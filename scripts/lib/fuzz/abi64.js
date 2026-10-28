// Minimal QRVM ABI codec for the QNS fuzzer. QRL 2.0 ABI words hold 64 bytes:
// addresses fill a word, bytesN values are left-aligned, integers and bools
// are right-aligned, and dynamic bytes or strings use an offset word, a length
// word and data right-padded to a whole number of words.
const { keccak_256 } = require("@noble/hashes/sha3.js");

const WORD = 64;
const utf8 = new TextEncoder();

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const fromHex = (value) => Buffer.from(value.replace(/^0x/, ""), "hex");
const keccak = (bytes) => Buffer.from(keccak_256(bytes));

function selector(signature) {
    return keccak(utf8.encode(signature)).subarray(0, 4);
}

function topicOfSignature(signature) {
    return leftWord(keccak(utf8.encode(signature)));
}

function leftWord(bytes) {
    if (bytes.length > WORD) throw new Error("left-aligned value exceeds one word");
    const word = Buffer.alloc(WORD);
    Buffer.from(bytes).copy(word, 0);
    return word;
}

function uintWord(value) {
    let remaining = BigInt(value);
    if (remaining < 0n) throw new Error("negative integer");
    const word = Buffer.alloc(WORD);
    for (let i = WORD - 1; i >= 0 && remaining > 0n; i--) {
        word[i] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    if (remaining > 0n) throw new Error("integer exceeds one word");
    return word;
}

function addressWord(address) {
    const raw = typeof address === "string" ? fromHex(address.replace(/^Q/, "")) : Buffer.from(address);
    if (raw.length !== WORD) throw new Error(`address must have 64 bytes: ${String(address)}`);
    return Buffer.from(raw);
}

function padded(bytes) {
    const size = Math.ceil(bytes.length / WORD) * WORD;
    const out = Buffer.alloc(size);
    Buffer.from(bytes).copy(out, 0);
    return out;
}

function toBytes(type, value) {
    if (type === "string") return Buffer.from(utf8.encode(value));
    return typeof value === "string" ? fromHex(value) : Buffer.from(value);
}

function encodeStatic(type, value) {
    if (type === "address") return addressWord(value);
    if (type === "bool") return uintWord(value ? 1 : 0);
    if (/^uint\d+$/.test(type)) return uintWord(value);
    const fixed = /^bytes(\d+)$/.exec(type);
    if (fixed) {
        const bytes = typeof value === "string" ? fromHex(value) : Buffer.from(value);
        if (bytes.length !== Number(fixed[1])) throw new Error(`${type} value has ${bytes.length} bytes`);
        return leftWord(bytes);
    }
    throw new Error(`unsupported static ABI type ${type}`);
}

const isDynamic = (type) => type === "bytes" || type === "string";

function encode(types, values) {
    if (types.length !== values.length) throw new Error("ABI type and value counts differ");
    const head = [];
    const tail = [];
    let tailOffset = types.length * WORD;
    types.forEach((type, index) => {
        if (isDynamic(type)) {
            const data = toBytes(type, values[index]);
            head.push(uintWord(tailOffset));
            const encoded = Buffer.concat([uintWord(data.length), padded(data)]);
            tail.push(encoded);
            tailOffset += encoded.length;
        } else {
            head.push(encodeStatic(type, values[index]));
        }
    });
    return Buffer.concat([...head, ...tail]);
}

function encodeCall(signature, types, values) {
    return Buffer.concat([selector(signature), encode(types, values)]);
}

function readUint(word) {
    return BigInt(`0x${hex(word) || "0"}`);
}

// Strict decoder: rejects trailing or missing data so a codec mismatch shows
// up as a test failure.
function decode(types, data) {
    const buffer = Buffer.from(data);
    const values = [];
    let end = types.length * WORD;
    types.forEach((type, index) => {
        const word = buffer.subarray(index * WORD, (index + 1) * WORD);
        if (word.length !== WORD) throw new Error("ABI data too short");
        if (isDynamic(type)) {
            const offset = Number(readUint(word));
            const length = Number(readUint(buffer.subarray(offset, offset + WORD)));
            const start = offset + WORD;
            const bytes = buffer.subarray(start, start + length);
            if (bytes.length !== length) throw new Error("ABI dynamic data too short");
            values.push(type === "string" ? bytes.toString("utf8") : Buffer.from(bytes));
            end = Math.max(end, start + Math.ceil(length / WORD) * WORD);
        } else if (type === "address") {
            values.push(`Q${hex(word)}`);
        } else if (type === "bool") {
            values.push(readUint(word) === 1n);
        } else if (/^uint\d+$/.test(type)) {
            values.push(readUint(word));
        } else {
            const fixed = /^bytes(\d+)$/.exec(type);
            if (!fixed) throw new Error(`unsupported ABI type ${type}`);
            values.push(`0x${hex(word.subarray(0, Number(fixed[1])))}`);
        }
    });
    if (end !== buffer.length) throw new Error(`ABI data has ${buffer.length - end} unexpected bytes`);
    return values;
}

module.exports = {
    WORD,
    addressWord,
    decode,
    encode,
    encodeCall,
    fromHex,
    hex,
    keccak,
    leftWord,
    selector,
    topicOfSignature,
    uintWord,
};
