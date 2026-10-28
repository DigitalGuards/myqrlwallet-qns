// The observable state compared after every fuzz step: every public view of
// the five stateful QNS contracts over the fixed universe of names, labels,
// text keys and addresses. The driver executes the list in the VM and hashes
// the replies; the model predicts the same transcript.
const crypto = require("node:crypto");
const abi = require("./abi64");
const { encodeFunction } = require("./interface");
const { viewOutput } = require("./model");
const W = require("./world");

const TEXT_KEYS = Object.freeze(["url", "avatar", ""]);
const VIEW_SENDER = W.ACTORS.admin;
const ADDRESS_POOL = Object.freeze([...Object.values(W.ACTORS), ...Object.values(W.CONTRACTS), W.ZERO]);
// ERC-165, the resolver profiles, versioning, the omitted multichain profile, and invalid ids.
const INTERFACE_IDS = Object.freeze([
    "01ffc9a7",
    "3b3b57de",
    "59d1d43c",
    "bc1c58d1",
    "691f3431",
    "d700ff33",
    "f1cb7e06",
    "ffffffff",
    "00000000",
]);

function observationList() {
    const views = [];
    for (const node of Object.values(W.NODES)) {
        for (const fn of ["owner", "resolver", "ttl", "recordExists"]) views.push(["registry", fn, [node]]);
        for (const fn of ["addr", "contenthash", "name", "recordVersions"]) views.push(["resolver", fn, [node]]);
        for (const key of TEXT_KEYS) views.push(["resolver", "text", [node, key]]);
    }
    for (const owner of Object.values(W.ACTORS)) {
        for (const operator of ADDRESS_POOL) views.push(["registry", "isApprovedForAll", [owner, operator]]);
    }
    views.push(["root", "owner", []], ["rr", "owner", []], ["rr", "defaultResolver", []]);
    for (const address of ADDRESS_POOL) views.push(["root", "controllers", [address]], ["rr", "controllers", [address]]);
    for (const label of Object.values(W.LABELS)) views.push(["root", "locked", [label]], ["fifs", "available", [label]]);
    // Pure and immutable getters: the 64-byte reverse node of every pooled
    // address, the registry wiring and the advertised interfaces.
    for (const address of ADDRESS_POOL) views.push(["rr", "node", [address]]);
    for (const contract of ["root", "rr", "fifs", "resolver"]) views.push([contract, "qns", []], [contract, "ens", []]);
    views.push(["fifs", "baseNode", []], ["resolver", "trustedReverseRegistrar", []]);
    for (const id of INTERFACE_IDS) views.push(["root", "supportsInterface", [id]], ["resolver", "supportsInterface", [id]]);
    return views;
}

const OBSERVATIONS = Object.freeze(observationList());

function viewListCommands() {
    return [
        `viewlist ${OBSERVATIONS.length}`,
        ...OBSERVATIONS.map(
            ([contract, fn, args]) => `${VIEW_SENDER} ${W.CONTRACTS[contract]} ${abi.hex(encodeFunction(contract, fn, args))}`
        ),
    ];
}

// A view of a contract that is not deployed yet runs no code and returns
// empty data, which is what the driver reports during the setup steps.
function expectedOutputs(state) {
    return OBSERVATIONS.map(([contract, fn, args]) =>
        state.deployed.has(contract) ? viewOutput(state, contract, fn, args) : Buffer.alloc(0)
    );
}

// Same transcript layout as the driver: status byte, 4-byte length, output.
function digestOf(outputs) {
    const hash = crypto.createHash("sha256");
    const header = Buffer.alloc(5);
    for (const output of outputs) {
        header.writeUInt8(0, 0);
        header.writeUInt32BE(output.length, 1);
        hash.update(header);
        hash.update(output);
    }
    return hash.digest("hex");
}

module.exports = { ADDRESS_POOL, INTERFACE_IDS, OBSERVATIONS, TEXT_KEYS, VIEW_SENDER, digestOf, expectedOutputs, viewListCommands };
