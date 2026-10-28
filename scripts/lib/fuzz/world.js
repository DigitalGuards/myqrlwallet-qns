// Fixed universe for the QNS stateful fuzzer: actors, names, the production
// deployment order from scripts/deploy-testnet.js, and the CREATE addresses the
// test host assigns. Addresses are 128 lowercase hex characters (64 bytes).
const fs = require("node:fs");
const path = require("node:path");
const { keccak } = require("./abi64");

const ZERO = "00".repeat(64);
const MAX = "ff".repeat(64);
const ZERO_NODE = "00".repeat(32);

// Actor pairs differ only in their high bytes, so any truncation of a 64-byte
// address to 63, 32 or 20 bytes merges two identities and fails the model.
const ACTORS = Object.freeze({
    admin: "00".repeat(44) + "12".repeat(20),
    alice: "a1".repeat(64),
    aliceHigh: "5a" + "a1".repeat(63),
    bob: "00".repeat(32) + "b0".repeat(32),
    bobHigh: "ff".repeat(32) + "b0".repeat(32),
    carol: "00".repeat(44) + "c0".repeat(20),
    carolHigh: "01" + "00".repeat(43) + "c0".repeat(20),
    max: MAX,
});
const ACTOR_NAMES = Object.keys(ACTORS);

const utf8 = (text) => Buffer.from(text, "utf8");
const labelhash = (label) => keccak(utf8(label)).toString("hex");
const subnode = (node, label) => keccak(Buffer.from(node + label, "hex")).toString("hex");
function namehash(name) {
    let node = ZERO_NODE;
    if (!name) return node;
    for (const label of name.split(".").reverse()) node = subnode(node, labelhash(label));
    return node;
}

// The production reverse label: keccak256 of the 128 lowercase hex characters.
const reverseLabel = (address) => keccak(utf8(address.toLowerCase())).toString("hex");
const ADDR_REVERSE_NODE = namehash("addr.reverse");
const reverseNode = (address) => subnode(ADDR_REVERSE_NODE, reverseLabel(address));

// Labels: the two production TLDs, three .qrl names, one shared child label,
// and two raw bytes32 labels that differ only in their final byte.
const LABELS = Object.freeze({
    qrl: labelhash("qrl"),
    reverse: labelhash("reverse"),
    addr: labelhash("addr"),
    alice: labelhash("alice"),
    bob: labelhash("bob"),
    carol: labelhash("carol"),
    sub: labelhash("sub"),
    rawLow: "00".repeat(31) + "01",
    rawLowTwin: "00".repeat(31) + "02",
});

const NODES = (() => {
    const qrl = namehash("qrl");
    const alice = subnode(qrl, LABELS.alice);
    const bob = subnode(qrl, LABELS.bob);
    return Object.freeze({
        root: ZERO_NODE,
        qrl,
        reverse: namehash("reverse"),
        addrReverse: ADDR_REVERSE_NODE,
        alice,
        bob,
        carol: subnode(qrl, LABELS.carol),
        subAlice: subnode(alice, LABELS.sub),
        subBob: subnode(bob, LABELS.sub),
        rawLow: subnode(ZERO_NODE, LABELS.rawLow),
        rawLowTwin: subnode(ZERO_NODE, LABELS.rawLowTwin),
        ...Object.fromEntries(ACTOR_NAMES.map((name) => [`reverse:${name}`, reverseNode(ACTORS[name])])),
    });
})();

// CREATE addresses as the hyptest QRVMHost derives them: keccak over its
// fixed list prefix, the 64-byte sender and the RLP nonce, right-aligned.
function rlpNonce(nonce) {
    if (nonce === 0) return Buffer.from([0x80]);
    if (nonce <= 0x7f) return Buffer.from([nonce]);
    if (nonce <= 0xff) return Buffer.from([0x81, nonce]);
    throw new Error("nonce out of range for the fuzz world");
}
function createAddress(sender, nonce) {
    const encodedNonce = rlpNonce(nonce);
    const preimage = Buffer.concat([
        Buffer.from([0xc0 + 49 + encodedNonce.length, 0xb0]),
        Buffer.from(sender, "hex"),
        encodedNonce,
    ]);
    return "00".repeat(32) + keccak(preimage).toString("hex");
}

const CONTRACTS = Object.freeze({
    registry: createAddress(ACTORS.admin, 1),
    root: createAddress(ACTORS.admin, 2),
    fifs: createAddress(ACTORS.admin, 3),
    rr: createAddress(ACTORS.admin, 4),
    resolver: createAddress(ACTORS.admin, 5),
    verifier: createAddress(ACTORS.admin, 6),
});

const ARTIFACT_NAMES = Object.freeze({
    registry: "QNSRegistry",
    root: "Root",
    fifs: "FIFSQRLRegistrar",
    rr: "ReverseRegistrar",
    resolver: "QRLPublicResolver",
    verifier: "QRLSignatureVerifier",
});

function loadArtifacts(artifactsDir) {
    const artifacts = {};
    for (const [key, name] of Object.entries(ARTIFACT_NAMES)) {
        artifacts[key] = fs.readFileSync(path.join(artifactsDir, `${name}.bin`), "utf8").trim();
    }
    return artifacts;
}

// Production wiring, in scripts/deploy-testnet.js order.
const SETUP = Object.freeze([
    { actor: "admin", deploy: "registry", args: [] },
    { actor: "admin", deploy: "root", args: [CONTRACTS.registry] },
    { actor: "admin", contract: "registry", fn: "setOwner", args: [ZERO_NODE, CONTRACTS.root] },
    { actor: "admin", contract: "root", fn: "setController", args: [ACTORS.admin, true] },
    { actor: "admin", deploy: "fifs", args: [CONTRACTS.registry, NODES.qrl] },
    { actor: "admin", contract: "root", fn: "setSubnodeOwner", args: [LABELS.qrl, CONTRACTS.fifs] },
    { actor: "admin", contract: "root", fn: "setSubnodeOwner", args: [LABELS.reverse, ACTORS.admin] },
    { actor: "admin", deploy: "rr", args: [CONTRACTS.registry] },
    {
        actor: "admin",
        contract: "registry",
        fn: "setSubnodeOwner",
        args: [NODES.reverse, LABELS.addr, CONTRACTS.rr],
    },
    { actor: "admin", deploy: "resolver", args: [CONTRACTS.registry, CONTRACTS.rr] },
    { actor: "admin", deploy: "verifier", args: [] },
    { actor: "admin", contract: "rr", fn: "setDefaultResolver", args: [CONTRACTS.resolver] },
]);

module.exports = {
    ACTORS,
    ACTOR_NAMES,
    ADDR_REVERSE_NODE,
    ARTIFACT_NAMES,
    CONTRACTS,
    LABELS,
    MAX,
    NODES,
    SETUP,
    ZERO,
    ZERO_NODE,
    createAddress,
    labelhash,
    loadArtifacts,
    namehash,
    reverseLabel,
    reverseNode,
    subnode,
};
