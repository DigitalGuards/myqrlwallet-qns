// Function, event and error signatures of the six QNS contracts, as compiled
// from contracts/hyperion. The fuzzer encodes every call from this table.
const abi = require("./abi64");

const FUNCTIONS = Object.freeze({
    registry: {
        setRecord: ["setRecord(bytes32,address,address,uint64)", ["bytes32", "address", "address", "uint64"], []],
        setSubnodeRecord: [
            "setSubnodeRecord(bytes32,bytes32,address,address,uint64)",
            ["bytes32", "bytes32", "address", "address", "uint64"],
            [],
        ],
        setOwner: ["setOwner(bytes32,address)", ["bytes32", "address"], []],
        setSubnodeOwner: ["setSubnodeOwner(bytes32,bytes32,address)", ["bytes32", "bytes32", "address"], ["bytes32"]],
        setResolver: ["setResolver(bytes32,address)", ["bytes32", "address"], []],
        setTTL: ["setTTL(bytes32,uint64)", ["bytes32", "uint64"], []],
        setApprovalForAll: ["setApprovalForAll(address,bool)", ["address", "bool"], []],
        owner: ["owner(bytes32)", ["bytes32"], ["address"]],
        resolver: ["resolver(bytes32)", ["bytes32"], ["address"]],
        ttl: ["ttl(bytes32)", ["bytes32"], ["uint64"]],
        recordExists: ["recordExists(bytes32)", ["bytes32"], ["bool"]],
        isApprovedForAll: ["isApprovedForAll(address,address)", ["address", "address"], ["bool"]],
    },
    root: {
        setSubnodeOwner: ["setSubnodeOwner(bytes32,address)", ["bytes32", "address"], []],
        setResolver: ["setResolver(address)", ["address"], []],
        lock: ["lock(bytes32)", ["bytes32"], []],
        setController: ["setController(address,bool)", ["address", "bool"], []],
        transferOwnership: ["transferOwnership(address)", ["address"], []],
        renounceOwnership: ["renounceOwnership()", [], []],
        owner: ["owner()", [], ["address"]],
        controllers: ["controllers(address)", ["address"], ["bool"]],
        locked: ["locked(bytes32)", ["bytes32"], ["bool"]],
        qns: ["qns()", [], ["address"]],
        ens: ["ens()", [], ["address"]],
        supportsInterface: ["supportsInterface(bytes4)", ["bytes4"], ["bool"]],
    },
    rr: {
        setDefaultResolver: ["setDefaultResolver(address)", ["address"], []],
        claim: ["claim(address)", ["address"], ["bytes32"]],
        claimForAddr: ["claimForAddr(address,address,address)", ["address", "address", "address"], ["bytes32"]],
        claimWithResolver: ["claimWithResolver(address,address)", ["address", "address"], ["bytes32"]],
        setName: ["setName(string)", ["string"], ["bytes32"]],
        setNameForAddr: [
            "setNameForAddr(address,address,address,string)",
            ["address", "address", "address", "string"],
            ["bytes32"],
        ],
        setController: ["setController(address,bool)", ["address", "bool"], []],
        transferOwnership: ["transferOwnership(address)", ["address"], []],
        renounceOwnership: ["renounceOwnership()", [], []],
        node: ["node(address)", ["address"], ["bytes32"]],
        defaultResolver: ["defaultResolver()", [], ["address"]],
        owner: ["owner()", [], ["address"]],
        controllers: ["controllers(address)", ["address"], ["bool"]],
        qns: ["qns()", [], ["address"]],
        ens: ["ens()", [], ["address"]],
    },
    fifs: {
        register: ["register(bytes32,address)", ["bytes32", "address"], []],
        available: ["available(bytes32)", ["bytes32"], ["bool"]],
        baseNode: ["baseNode()", [], ["bytes32"]],
        qns: ["qns()", [], ["address"]],
        ens: ["ens()", [], ["address"]],
    },
    resolver: {
        setAddr: ["setAddr(bytes32,address)", ["bytes32", "address"], []],
        setText: ["setText(bytes32,string,string)", ["bytes32", "string", "string"], []],
        setContenthash: ["setContenthash(bytes32,bytes)", ["bytes32", "bytes"], []],
        setName: ["setName(bytes32,string)", ["bytes32", "string"], []],
        clearRecords: ["clearRecords(bytes32)", ["bytes32"], []],
        addr: ["addr(bytes32)", ["bytes32"], ["address"]],
        text: ["text(bytes32,string)", ["bytes32", "string"], ["string"]],
        contenthash: ["contenthash(bytes32)", ["bytes32"], ["bytes"]],
        name: ["name(bytes32)", ["bytes32"], ["string"]],
        recordVersions: ["recordVersions(bytes32)", ["bytes32"], ["uint64"]],
        trustedReverseRegistrar: ["trustedReverseRegistrar()", [], ["address"]],
        supportsInterface: ["supportsInterface(bytes4)", ["bytes4"], ["bool"]],
        qns: ["qns()", [], ["address"]],
        ens: ["ens()", [], ["address"]],
    },
});

const CONSTRUCTORS = Object.freeze({
    registry: [],
    root: ["address"],
    fifs: ["address", "bytes32"],
    rr: ["address"],
    resolver: ["address", "address"],
    verifier: [],
});

const EVENTS = Object.freeze({
    NewOwner: "NewOwner(bytes32,bytes32,address)",
    Transfer: "Transfer(bytes32,address)",
    NewResolver: "NewResolver(bytes32,address)",
    NewTTL: "NewTTL(bytes32,uint64)",
    ApprovalForAll: "ApprovalForAll(address,address,bool)",
    TLDLocked: "TLDLocked(bytes32)",
    ControllerChanged: "ControllerChanged(address,bool)",
    OwnershipTransferred: "OwnershipTransferred(address,address)",
    ReverseClaimed: "ReverseClaimed(address,bytes32)",
    DefaultResolverChanged: "DefaultResolverChanged(address)",
    Registered: "Registered(bytes32,address)",
    AddrChanged: "AddrChanged(bytes32,address)",
    TextChanged: "TextChanged(bytes32,string,string,string)",
    ContenthashChanged: "ContenthashChanged(bytes32,bytes)",
    NameChanged: "NameChanged(bytes32,string)",
    VersionChanged: "VersionChanged(bytes32,uint64)",
});

const EVENT_TOPICS = Object.freeze(
    Object.fromEntries(Object.entries(EVENTS).map(([name, signature]) => [name, abi.topicOfSignature(signature)]))
);

function encodeFunction(contract, fn, args) {
    const entry = FUNCTIONS[contract]?.[fn];
    if (!entry) throw new Error(`unknown function ${contract}.${fn}`);
    return abi.encodeCall(entry[0], entry[1], args);
}

function errorData(signature, types, values) {
    return abi.encodeCall(signature, types, values);
}

const revertString = (message) => errorData("Error(string)", ["string"], [message]);

module.exports = { CONSTRUCTORS, EVENTS, EVENT_TOPICS, FUNCTIONS, encodeFunction, errorData, revertString };
