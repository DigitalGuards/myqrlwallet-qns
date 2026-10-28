// Seeded generator of random QNS operation sequences. Choices are biased by
// the model state toward authorised actors and live names, so sequences reach
// deep states (subnodes, operators, reverse records, cleared records, moved
// TLDs) while still trying every revert path. The model state is a pure
// function of the seed, so a seed always reproduces the same sequence.
const crypto = require("node:crypto");
const { UINT64_MAX, applyStep } = require("./model");
const { ADDRESS_POOL, TEXT_KEYS } = require("./observe");
const W = require("./world");

// sfc32, seeded through splitmix32.
function createRandom(seed) {
    let state = seed >>> 0;
    const splitmix = () => {
        state = (state + 0x9e3779b9) >>> 0;
        let z = state;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
        return (z ^ (z >>> 16)) >>> 0;
    };
    let a = splitmix();
    let b = splitmix();
    let c = splitmix();
    let d = splitmix();
    const next = () => {
        const t = (((a + b) >>> 0) + d) >>> 0;
        d = (d + 1) >>> 0;
        a = b ^ (b >>> 9);
        b = (c + (c << 3)) >>> 0;
        c = ((c << 21) | (c >>> 11)) >>> 0;
        c = (c + t) >>> 0;
        return t >>> 0;
    };
    const random = {
        next,
        float: () => next() / 0x100000000,
        int: (n) => Math.floor((next() / 0x100000000) * n),
        pick: (items) => items[Math.floor((next() / 0x100000000) * items.length)],
        chance: (p) => next() / 0x100000000 < p,
    };
    return random;
}

function sequenceSeed(baseSeed, index) {
    const digest = crypto.createHash("sha256").update(`qns-fuzz:${baseSeed}:${index}`).digest();
    return digest.readUInt32BE(0);
}

const TEXT_VALUES = Object.freeze(["", "x", "https://qns.example/profile", "Grüße ✓ 名前", "z".repeat(130)]);
// Empty, one byte, exactly one 64-byte word, one byte over a word, several words.
const CONTENTHASHES = Object.freeze(["", "e3", "e301" + "ab".repeat(62), "e301" + "cd".repeat(63), "ef".repeat(130)]);
const NAMES = Object.freeze(["", "alice.qrl", "bob.qrl", "sub.alice.qrl", "ñame-ünicode.qrl", "n".repeat(100)]);
const TTLS = Object.freeze([0n, 1n, 3600n, UINT64_MAX]);

const ACTOR_NAMES = W.ACTOR_NAMES;
const NODE_LIST = Object.freeze(Object.values(W.NODES));
const LABEL_LIST = Object.freeze(Object.values(W.LABELS));
const OBSERVED_NODES = new Set(NODE_LIST);
const actorOf = (address) => ACTOR_NAMES.find((name) => W.ACTORS[name] === address);

// Child labels whose subnode is one of the observed nodes, per parent. Most
// subnode writes use these edges so their effect is visible in the views.
const OBSERVED_EDGES = (() => {
    const labels = [...LABEL_LIST, ...Object.values(W.ACTORS).map(W.reverseLabel)];
    const edges = new Map();
    for (const parent of NODE_LIST) {
        const children = labels.filter((label) => OBSERVED_NODES.has(W.subnode(parent, label)));
        if (children.length) edges.set(parent, children);
    }
    return edges;
})();
const TLD_LABELS = Object.freeze([W.LABELS.qrl, W.LABELS.reverse, W.LABELS.rawLow, W.LABELS.rawLowTwin]);
const QRL_LABELS = Object.freeze([W.LABELS.alice, W.LABELS.bob, W.LABELS.carol]);

function chooseChildLabel(random, parent) {
    const observed = OBSERVED_EDGES.get(parent);
    return observed && random.chance(0.8) ? random.pick(observed) : random.pick(LABEL_LIST);
}
const chooseFrom = (random, preferred) => (random.chance(0.8) ? random.pick(preferred) : random.pick(LABEL_LIST));

function authorisedActors(state, node) {
    const owner = state.registry.records.get(node)?.owner ?? W.ZERO;
    return ACTOR_NAMES.filter(
        (name) => W.ACTORS[name] === owner || state.registry.operators.has(`${owner}:${W.ACTORS[name]}`)
    );
}

function chooseAddress(random) {
    const roll = random.float();
    if (roll < 0.7) return W.ACTORS[random.pick(ACTOR_NAMES)];
    if (roll < 0.9) return random.pick(Object.values(W.CONTRACTS));
    return random.pick([W.ZERO, W.MAX]);
}
const chooseResolver = (random) => (random.chance(0.6) ? W.CONTRACTS.resolver : random.pick(ADDRESS_POOL));

function chooseNodeActor(random, state, node) {
    const authorised = authorisedActors(state, node);
    if (authorised.length > 0 && random.chance(0.6)) return random.pick(authorised);
    return random.pick(ACTOR_NAMES);
}

function ownerActor(random, state, contract) {
    const owner = actorOf(state[contract].owner);
    return owner && random.chance(0.6) ? owner : random.pick(ACTOR_NAMES);
}

function controllerActor(random, state, contract) {
    const controllers = ACTOR_NAMES.filter((name) => state[contract].controllers.has(W.ACTORS[name]));
    return controllers.length > 0 && random.chance(0.6) ? random.pick(controllers) : random.pick(ACTOR_NAMES);
}

// [weight, builder(random, state) -> step]
const OPERATIONS = Object.freeze([
    [4, (r, s) => nodeStep(r, s, "registry", "setOwner", (node) => [node, chooseAddress(r)])],
    [6, (r, s) => nodeStep(r, s, "registry", "setSubnodeOwner", (node) => [node, chooseChildLabel(r, node), chooseAddress(r)])],
    [4, (r, s) => nodeStep(r, s, "registry", "setResolver", (node) => [node, chooseResolver(r)])],
    [2, (r, s) => nodeStep(r, s, "registry", "setTTL", (node) => [node, r.pick(TTLS)])],
    [3, (r, s) => nodeStep(r, s, "registry", "setRecord", (node) => [node, chooseAddress(r), chooseResolver(r), r.pick(TTLS)])],
    [
        3,
        (r, s) =>
            nodeStep(r, s, "registry", "setSubnodeRecord", (node) => [
                node,
                chooseChildLabel(r, node),
                chooseAddress(r),
                chooseResolver(r),
                r.pick(TTLS),
            ]),
    ],
    [5, (r) => ({ actor: r.pick(ACTOR_NAMES), contract: "registry", fn: "setApprovalForAll", args: [r.pick(ADDRESS_POOL), r.chance(0.7)] })],
    [3, (r, s) => ({ actor: controllerActor(r, s, "root"), contract: "root", fn: "setSubnodeOwner", args: [chooseFrom(r, TLD_LABELS), chooseAddress(r)] })],
    [1, (r, s) => ({ actor: ownerActor(r, s, "root"), contract: "root", fn: "setResolver", args: [chooseResolver(r)] })],
    [1, (r, s) => ({ actor: ownerActor(r, s, "root"), contract: "root", fn: "lock", args: [chooseFrom(r, TLD_LABELS)] })],
    [2, (r, s) => ({ actor: ownerActor(r, s, "root"), contract: "root", fn: "setController", args: [r.pick(ADDRESS_POOL), r.chance(0.7)] })],
    [0.5, (r, s) => ({ actor: ownerActor(r, s, "root"), contract: "root", fn: "transferOwnership", args: [chooseAddress(r)] })],
    [0.2, (r, s) => ({ actor: ownerActor(r, s, "root"), contract: "root", fn: "renounceOwnership", args: [] })],
    [3, (r) => ({ actor: r.pick(ACTOR_NAMES), contract: "rr", fn: "claim", args: [chooseAddress(r)] })],
    [4, (r, s) => claimForAddrStep(r, s)],
    [2, (r) => ({ actor: r.pick(ACTOR_NAMES), contract: "rr", fn: "claimWithResolver", args: [chooseAddress(r), chooseResolver(r)] })],
    [4, (r) => ({ actor: r.pick(ACTOR_NAMES), contract: "rr", fn: "setName", args: [r.pick(NAMES)] })],
    [
        4,
        (r, s) => {
            const claim = claimForAddrStep(r, s);
            return { ...claim, fn: "setNameForAddr", args: [...claim.args, r.pick(NAMES)] };
        },
    ],
    [1, (r, s) => ({ actor: ownerActor(r, s, "rr"), contract: "rr", fn: "setDefaultResolver", args: [chooseResolver(r)] })],
    [2, (r, s) => ({ actor: ownerActor(r, s, "rr"), contract: "rr", fn: "setController", args: [r.pick(ADDRESS_POOL), r.chance(0.7)] })],
    [0.5, (r, s) => ({ actor: ownerActor(r, s, "rr"), contract: "rr", fn: "transferOwnership", args: [chooseAddress(r)] })],
    [0.2, (r, s) => ({ actor: ownerActor(r, s, "rr"), contract: "rr", fn: "renounceOwnership", args: [] })],
    [8, (r) => ({ actor: r.pick(ACTOR_NAMES), contract: "fifs", fn: "register", args: [chooseFrom(r, QRL_LABELS), chooseAddress(r)] })],
    [5, (r, s) => nodeStep(r, s, "resolver", "setAddr", (node) => [node, chooseAddress(r)])],
    [4, (r, s) => nodeStep(r, s, "resolver", "setText", (node) => [node, r.pick(TEXT_KEYS), r.pick(TEXT_VALUES)])],
    [3, (r, s) => nodeStep(r, s, "resolver", "setContenthash", (node) => [node, r.pick(CONTENTHASHES)])],
    [3, (r, s) => nodeStep(r, s, "resolver", "setName", (node) => [node, r.pick(NAMES)])],
    [2, (r, s) => nodeStep(r, s, "resolver", "clearRecords", (node) => [node])],
]);
const TOTAL_WEIGHT = OPERATIONS.reduce((sum, [weight]) => sum + weight, 0);

// Prefers names some actor can currently write, so sequences grow deep trees.
function nodeStep(random, state, contract, fn, buildArgs) {
    const live = NODE_LIST.filter((node) => authorisedActors(state, node).length > 0);
    const node = live.length > 0 && random.chance(0.7) ? random.pick(live) : random.pick(NODE_LIST);
    return { actor: chooseNodeActor(random, state, node), contract, fn, args: buildArgs(node) };
}

function claimForAddrStep(random) {
    const actor = random.pick(ACTOR_NAMES);
    let addr;
    const roll = random.float();
    if (roll < 0.4) addr = W.ACTORS[actor];
    else if (roll < 0.8) addr = W.ACTORS[random.pick(ACTOR_NAMES)];
    else addr = random.pick(Object.values(W.CONTRACTS));
    return { actor, contract: "rr", fn: "claimForAddr", args: [addr, chooseAddress(random), chooseResolver(random)] };
}

function pickOperation(random) {
    let roll = random.float() * TOTAL_WEIGHT;
    for (const [weight, build] of OPERATIONS) {
        roll -= weight;
        if (roll < 0) return build;
    }
    return OPERATIONS[OPERATIONS.length - 1][1];
}

// Returns the steps with the model's expected result and post-state for each.
function generateSequence(seed, length, initialState) {
    const random = createRandom(seed);
    let state = initialState;
    const steps = [];
    const results = [];
    const states = [];
    for (let i = 0; i < length; i++) {
        const step = pickOperation(random)(random, state);
        const applied = applyStep(state, step);
        state = applied.state;
        steps.push(step);
        results.push(applied.result);
        states.push(state);
    }
    return { steps, results, states };
}

module.exports = { CONTENTHASHES, NAMES, TEXT_VALUES, TTLS, createRandom, generateSequence, sequenceSeed };
