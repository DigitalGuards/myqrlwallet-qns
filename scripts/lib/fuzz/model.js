// JavaScript reference model of the deployed QNS semantics: the registry,
// Root with Controllable and Ownable, the reverse registrar, the FIFS
// registrar and the public resolver. It is written from the Hyperion sources
// and ENS v1 semantics, independently of the VM, and predicts the status,
// return data, ordered logs and observable state of every call.
const abi = require("./abi64");
const { EVENT_TOPICS, FUNCTIONS, errorData, revertString } = require("./interface");
const W = require("./world");

const { ZERO, ZERO_NODE, CONTRACTS, ADDR_REVERSE_NODE } = W;
const CONTROLLER_ERROR = "Controllable: Caller is not a controller";
const REVERSE_AUTH_ERROR =
    "ReverseRegistrar: Caller is not a controller or authorised by address or the address itself";
const REVERSE_ZERO_RESOLVER_ERROR = "ReverseRegistrar: Resolver address must not be 0";
const UINT64_MAX = (1n << 64n) - 1n;
// IERC165, IAddrResolver, ITextResolver, IContentHashResolver, INameResolver, IVersionableResolver.
const RESOLVER_INTERFACES = new Set(["01ffc9a7", "3b3b57de", "59d1d43c", "bc1c58d1", "691f3431", "d700ff33"]);

// Seeded model mutations for the fuzzer self-test (scripts/fuzz-qns.js
// --self-test). Each one plants a plausible port bug in the oracle; the
// self-test passes only when the fuzzer reports a mismatch for every one.
const MUTATIONS = Object.freeze({
    "registry-ignores-operators": "registry writes ignore operator approvals",
    "resolver-honours-operators": "resolver writes accept registry operators",
    "address-low-32-bytes": "registry authorisation compares only the low 32 address bytes",
    "root-ignores-lock": "Root.setSubnodeOwner ignores locked labels",
    "reverse-label-20-bytes": "reverse labels hash a 20-byte address",
    "ttl-event-always": "setRecord emits NewTTL even when the TTL is unchanged",
    "clear-records-noop": "clearRecords keeps the record version",
    "owner-view-unmasked": "registry.owner returns the registry itself",
});
let activeMutation = null;
function setMutation(name) {
    if (name !== null && !MUTATIONS[name]) throw new Error(`unknown model mutation ${name}`);
    activeMutation = name;
}
const mutated = (name) => activeMutation === name;
const sameAddress = (a, b) => (mutated("address-low-32-bytes") ? a.slice(64) === b.slice(64) : a === b);
const reverseLabelOf = (address) =>
    mutated("reverse-label-20-bytes") ? W.reverseLabel(address.slice(88)) : W.reverseLabel(address);

class Revert extends Error {
    constructor(data = Buffer.alloc(0), reason = "revert") {
        super(reason);
        this.data = Buffer.from(data);
    }
}

function emptyState() {
    return {
        deployed: new Set(),
        nonces: new Map(),
        registry: { records: new Map(), operators: new Set() },
        root: { owner: ZERO, controllers: new Set(), locked: new Set(), qns: ZERO },
        rr: { owner: ZERO, controllers: new Set(), defaultResolver: ZERO, qns: ZERO },
        fifs: { qns: ZERO, baseNode: ZERO_NODE },
        resolver: {
            qns: ZERO,
            trusted: ZERO,
            versions: new Map(),
            addrs: new Map(),
            texts: new Map(),
            hashes: new Map(),
            names: new Map(),
        },
    };
}

const left = (bytes32) => abi.leftWord(Buffer.from(bytes32, "hex"));
const word = (address) => Buffer.from(address, "hex");
const log = (address, topics, data = Buffer.alloc(0)) => ({ address, topics, data: Buffer.from(data) });

class Execution {
    constructor(state) {
        this.state = state;
        this.logs = [];
    }

    // ---- registry ----
    record(node) {
        return this.state.registry.records.get(node) ?? { owner: ZERO, resolver: ZERO, ttl: 0n };
    }
    writeRecord(node, patch) {
        this.state.registry.records.set(node, { ...this.record(node), ...patch });
    }
    ownerView(node) {
        const owner = this.record(node).owner;
        return owner === CONTRACTS.registry && !mutated("owner-view-unmasked") ? ZERO : owner;
    }
    isOperator(owner, operator) {
        return this.state.registry.operators.has(`${owner}:${operator}`);
    }
    requireRegistryAuthorised(node, sender) {
        const owner = this.record(node).owner;
        const operator = !mutated("registry-ignores-operators") && this.isOperator(owner, sender);
        if (!(sameAddress(owner, sender) || operator)) throw new Revert();
    }
    registrySetOwner(sender, node, owner) {
        this.requireRegistryAuthorised(node, sender);
        this.writeRecord(node, { owner });
        this.logs.push(log(CONTRACTS.registry, [EVENT_TOPICS.Transfer, left(node)], word(owner)));
    }
    registrySetSubnodeOwner(sender, node, label, owner) {
        this.requireRegistryAuthorised(node, sender);
        const child = W.subnode(node, label);
        this.writeRecord(child, { owner });
        this.logs.push(log(CONTRACTS.registry, [EVENT_TOPICS.NewOwner, left(node), left(label)], word(owner)));
        return child;
    }
    registrySetResolver(sender, node, resolver) {
        this.requireRegistryAuthorised(node, sender);
        this.logs.push(log(CONTRACTS.registry, [EVENT_TOPICS.NewResolver, left(node)], word(resolver)));
        this.writeRecord(node, { resolver });
    }
    registrySetTTL(sender, node, ttl) {
        this.requireRegistryAuthorised(node, sender);
        this.logs.push(log(CONTRACTS.registry, [EVENT_TOPICS.NewTTL, left(node)], abi.uintWord(ttl)));
        this.writeRecord(node, { ttl: BigInt(ttl) });
    }
    setResolverAndTTL(node, resolver, ttl) {
        if (resolver !== this.record(node).resolver) {
            this.writeRecord(node, { resolver });
            this.logs.push(log(CONTRACTS.registry, [EVENT_TOPICS.NewResolver, left(node)], word(resolver)));
        }
        if (BigInt(ttl) !== this.record(node).ttl || mutated("ttl-event-always")) {
            this.writeRecord(node, { ttl: BigInt(ttl) });
            this.logs.push(log(CONTRACTS.registry, [EVENT_TOPICS.NewTTL, left(node)], abi.uintWord(ttl)));
        }
    }
    registry(sender, fn, args) {
        switch (fn) {
            case "setOwner":
                this.registrySetOwner(sender, args[0], args[1]);
                return Buffer.alloc(0);
            case "setSubnodeOwner":
                return left(this.registrySetSubnodeOwner(sender, args[0], args[1], args[2]));
            case "setResolver":
                this.registrySetResolver(sender, args[0], args[1]);
                return Buffer.alloc(0);
            case "setTTL":
                this.registrySetTTL(sender, args[0], args[1]);
                return Buffer.alloc(0);
            case "setRecord":
                this.registrySetOwner(sender, args[0], args[1]);
                this.setResolverAndTTL(args[0], args[2], args[3]);
                return Buffer.alloc(0);
            case "setSubnodeRecord": {
                const child = this.registrySetSubnodeOwner(sender, args[0], args[1], args[2]);
                this.setResolverAndTTL(child, args[3], args[4]);
                return Buffer.alloc(0);
            }
            case "setApprovalForAll": {
                const key = `${sender}:${args[0]}`;
                if (args[1]) this.state.registry.operators.add(key);
                else this.state.registry.operators.delete(key);
                this.logs.push(
                    log(CONTRACTS.registry, [EVENT_TOPICS.ApprovalForAll, word(sender), word(args[0])], abi.uintWord(args[1] ? 1 : 0))
                );
                return Buffer.alloc(0);
            }
            default:
                throw new Error(`model: unsupported registry.${fn}`);
        }
    }

    // ---- Ownable and Controllable (Root and ReverseRegistrar) ----
    onlyOwner(contract, sender) {
        if (this.state[contract].owner !== sender) {
            throw new Revert(errorData("OwnableUnauthorizedAccount(address)", ["address"], [sender]));
        }
    }
    ownable(contract, sender, fn, args) {
        const address = CONTRACTS[contract];
        const target = this.state[contract];
        switch (fn) {
            case "setController":
                this.onlyOwner(contract, sender);
                if (args[1]) target.controllers.add(args[0]);
                else target.controllers.delete(args[0]);
                this.logs.push(log(address, [EVENT_TOPICS.ControllerChanged, word(args[0])], abi.uintWord(args[1] ? 1 : 0)));
                return true;
            case "transferOwnership":
                this.onlyOwner(contract, sender);
                if (args[0] === ZERO) throw new Revert(errorData("OwnableInvalidOwner(address)", ["address"], [ZERO]));
                this.logs.push(log(address, [EVENT_TOPICS.OwnershipTransferred, word(target.owner), word(args[0])]));
                target.owner = args[0];
                return true;
            case "renounceOwnership":
                this.onlyOwner(contract, sender);
                this.logs.push(log(address, [EVENT_TOPICS.OwnershipTransferred, word(target.owner), word(ZERO)]));
                target.owner = ZERO;
                return true;
            default:
                return false;
        }
    }

    root(sender, fn, args) {
        if (this.ownable("root", sender, fn, args)) return Buffer.alloc(0);
        const root = this.state.root;
        switch (fn) {
            case "setSubnodeOwner":
                if (!root.controllers.has(sender)) throw new Revert(revertString(CONTROLLER_ERROR));
                if (root.locked.has(args[0]) && !mutated("root-ignores-lock")) throw new Revert();
                this.registrySetSubnodeOwner(CONTRACTS.root, ZERO_NODE, args[0], args[1]);
                return Buffer.alloc(0);
            case "setResolver":
                this.onlyOwner("root", sender);
                this.registrySetResolver(CONTRACTS.root, ZERO_NODE, args[0]);
                return Buffer.alloc(0);
            case "lock":
                this.onlyOwner("root", sender);
                this.logs.push(log(CONTRACTS.root, [EVENT_TOPICS.TLDLocked, left(args[0])]));
                root.locked.add(args[0]);
                return Buffer.alloc(0);
            default:
                throw new Error(`model: unsupported root.${fn}`);
        }
    }

    // ---- ReverseRegistrar ----
    // ownsContract(addr) calls Ownable(addr).owner() inside try/catch. Only Root
    // and the reverse registrar answer owner(); other deployed contracts revert
    // and the catch returns false. An address without code returns no data, and
    // decoding that empty reply reverts outside the try, so the whole call
    // reverts with empty data (the same as upstream ENS).
    ownsContract(addr, sender) {
        if (addr === CONTRACTS.root && this.state.deployed.has("root")) return this.state.root.owner === sender;
        if (addr === CONTRACTS.rr && this.state.deployed.has("rr")) return this.state.rr.owner === sender;
        const deployed = Object.entries(CONTRACTS).some(([key, address]) => address === addr && this.state.deployed.has(key));
        if (deployed) return false;
        throw new Revert(Buffer.alloc(0), "owner() on an address without code");
    }
    requireReverseAuthorised(addr, sender) {
        const allowed =
            addr === sender ||
            this.state.rr.controllers.has(sender) ||
            this.isOperator(addr, sender) ||
            this.ownsContract(addr, sender);
        if (!allowed) throw new Revert(revertString(REVERSE_AUTH_ERROR));
    }
    claimForAddr(sender, addr, owner, resolver) {
        this.requireReverseAuthorised(addr, sender);
        const label = reverseLabelOf(addr);
        const node = W.subnode(ADDR_REVERSE_NODE, label);
        this.logs.push(log(CONTRACTS.rr, [EVENT_TOPICS.ReverseClaimed, word(addr), left(node)]));
        const child = this.registrySetSubnodeOwner(CONTRACTS.rr, ADDR_REVERSE_NODE, label, owner);
        this.setResolverAndTTL(child, resolver, 0n);
        return node;
    }
    setNameForAddr(sender, addr, owner, resolver, name) {
        const node = this.claimForAddr(sender, addr, owner, resolver);
        // NameResolver(resolver).setName(node, name): only the deployed public
        // resolver implements it. Calls to an address without code fail the
        // extcodesize check and other contracts have no matching function.
        if (resolver !== CONTRACTS.resolver || !this.state.deployed.has("resolver")) throw new Revert();
        this.resolverSetName(CONTRACTS.rr, node, name);
        return node;
    }
    rr(sender, fn, args) {
        if (this.ownable("rr", sender, fn, args)) return Buffer.alloc(0);
        const rr = this.state.rr;
        switch (fn) {
            case "setDefaultResolver":
                this.onlyOwner("rr", sender);
                if (args[0] === ZERO) throw new Revert(revertString(REVERSE_ZERO_RESOLVER_ERROR));
                rr.defaultResolver = args[0];
                this.logs.push(log(CONTRACTS.rr, [EVENT_TOPICS.DefaultResolverChanged, word(args[0])]));
                return Buffer.alloc(0);
            case "claim":
                return left(this.claimForAddr(sender, sender, args[0], rr.defaultResolver));
            case "claimForAddr":
                return left(this.claimForAddr(sender, args[0], args[1], args[2]));
            case "claimWithResolver":
                return left(this.claimForAddr(sender, sender, args[0], args[1]));
            case "setName":
                return left(this.setNameForAddr(sender, sender, sender, rr.defaultResolver, args[0]));
            case "setNameForAddr":
                return left(this.setNameForAddr(sender, args[0], args[1], args[2], args[3]));
            default:
                throw new Error(`model: unsupported rr.${fn}`);
        }
    }

    // ---- FIFSQRLRegistrar ----
    fifs(sender, fn, args) {
        if (fn !== "register") throw new Error(`model: unsupported fifs.${fn}`);
        const [label, owner] = args;
        const base = this.state.fifs.baseNode;
        const current = this.ownerView(W.subnode(base, label));
        if (current !== ZERO && current !== sender) {
            throw new Revert(errorData("NotAvailable(bytes32,address)", ["bytes32", "address"], [label, current]));
        }
        this.registrySetSubnodeOwner(CONTRACTS.fifs, base, label, owner);
        this.logs.push(log(CONTRACTS.fifs, [EVENT_TOPICS.Registered, left(label), word(owner)]));
        return Buffer.alloc(0);
    }

    // ---- QRLPublicResolver ----
    version(node) {
        return this.state.resolver.versions.get(node) ?? 0n;
    }
    requireResolverAuthorised(node, sender) {
        const owner = this.ownerView(node);
        if (owner === sender) return;
        if (mutated("resolver-honours-operators") && this.isOperator(owner, sender)) return;
        throw new Revert();
    }
    resolverSetName(sender, node, name) {
        const trusted = this.state.resolver.trusted;
        if (!(this.ownerView(node) === sender || (trusted !== ZERO && sender === trusted))) {
            throw new Revert(errorData("NotAuthorised(bytes32,address)", ["bytes32", "address"], [node, sender]));
        }
        this.state.resolver.names.set(`${this.version(node)}:${node}`, name);
        this.logs.push(log(CONTRACTS.resolver, [EVENT_TOPICS.NameChanged, left(node)], abi.encode(["string"], [name])));
    }
    resolver(sender, fn, args) {
        const resolver = this.state.resolver;
        const node = args[0];
        switch (fn) {
            case "setAddr":
                this.requireResolverAuthorised(node, sender);
                resolver.addrs.set(`${this.version(node)}:${node}`, args[1]);
                this.logs.push(log(CONTRACTS.resolver, [EVENT_TOPICS.AddrChanged, left(node)], word(args[1])));
                return Buffer.alloc(0);
            case "setText":
                this.requireResolverAuthorised(node, sender);
                resolver.texts.set(`${this.version(node)}:${node}:${args[1]}`, args[2]);
                this.logs.push(
                    log(
                        CONTRACTS.resolver,
                        [EVENT_TOPICS.TextChanged, left(node), abi.leftWord(abi.keccak(Buffer.from(args[1], "utf8")))],
                        abi.encode(["string", "string"], [args[1], args[2]])
                    )
                );
                return Buffer.alloc(0);
            case "setContenthash":
                this.requireResolverAuthorised(node, sender);
                resolver.hashes.set(`${this.version(node)}:${node}`, args[1]);
                this.logs.push(
                    log(CONTRACTS.resolver, [EVENT_TOPICS.ContenthashChanged, left(node)], abi.encode(["bytes"], [args[1]]))
                );
                return Buffer.alloc(0);
            case "setName":
                this.resolverSetName(sender, node, args[1]);
                return Buffer.alloc(0);
            case "clearRecords": {
                this.requireResolverAuthorised(node, sender);
                const next = this.version(node) + (mutated("clear-records-noop") ? 0n : 1n);
                if (next > UINT64_MAX) throw new Error("model: version overflow is out of scope");
                resolver.versions.set(node, next);
                this.logs.push(log(CONTRACTS.resolver, [EVENT_TOPICS.VersionChanged, left(node)], abi.uintWord(next)));
                return Buffer.alloc(0);
            }
            default:
                throw new Error(`model: unsupported resolver.${fn}`);
        }
    }

    // ---- deployment (constructors) ----
    deploy(sender, contract, args) {
        const nonce = (this.state.nonces.get(sender) ?? 0) + 1;
        this.state.nonces.set(sender, nonce);
        const address = W.createAddress(sender, nonce);
        if (address !== CONTRACTS[contract]) throw new Error(`model: ${contract} would deploy at an unexpected address`);
        const ownableConstructor = (target) => {
            if (sender === ZERO) throw new Revert(errorData("OwnableInvalidOwner(address)", ["address"], [ZERO]));
            this.logs.push(log(address, [EVENT_TOPICS.OwnershipTransferred, word(ZERO), word(sender)]));
            this.state[target].owner = sender;
        };
        switch (contract) {
            case "registry":
                this.writeRecord(ZERO_NODE, { owner: sender });
                break;
            case "root":
                ownableConstructor("root");
                this.state.root.qns = args[0];
                break;
            case "fifs":
                this.state.fifs.qns = args[0];
                this.state.fifs.baseNode = args[1];
                break;
            case "rr":
                ownableConstructor("rr");
                this.state.rr.qns = args[0];
                if (this.ownerView(ADDR_REVERSE_NODE) !== ZERO) {
                    throw new Error("model: redeploying the reverse registrar over a live one is out of scope");
                }
                break;
            case "resolver":
                this.state.resolver.qns = args[0];
                this.state.resolver.trusted = args[1];
                break;
            case "verifier":
                break;
            default:
                throw new Error(`model: unknown contract ${contract}`);
        }
        this.state.deployed.add(contract);
        return address;
    }
}

// Applies one step atomically. Returns { status, output, logs, created }.
function applyStep(state, step) {
    const draft = structuredClone(state);
    const execution = new Execution(draft);
    const sender = W.ACTORS[step.actor] ?? step.actor;
    try {
        if (step.deploy) {
            const created = execution.deploy(sender, step.deploy, step.args);
            return { state: draft, result: { status: "success", output: Buffer.alloc(0), logs: execution.logs, created } };
        }
        if (!state.deployed.has(step.contract)) throw new Error(`model: ${step.contract} is not deployed`);
        const output = execution[step.contract](sender, step.fn, step.args);
        return { state: draft, result: { status: "success", output, logs: execution.logs, created: null } };
    } catch (error) {
        if (!(error instanceof Revert)) throw error;
        // A failed deployment still consumes the creator nonce in the test host.
        if (step.deploy) state.nonces.set(sender, (state.nonces.get(sender) ?? 0) + 1);
        return { state, result: { status: "revert", output: error.data, logs: [], created: null } };
    }
}

// ---- observable state ----
function viewOutput(state, target, fn, args) {
    const execution = new Execution(state);
    const types = FUNCTIONS[target][fn][2];
    const encode = (value) => abi.encode(types, [value]);
    const r = state.resolver;
    const versioned = (node) => `${execution.version(node)}:${node}`;
    switch (`${target}.${fn}`) {
        case "registry.owner":
            return encode(execution.ownerView(args[0]));
        case "registry.resolver":
            return encode(execution.record(args[0]).resolver);
        case "registry.ttl":
            return encode(execution.record(args[0]).ttl);
        case "registry.recordExists":
            return encode(execution.record(args[0]).owner !== ZERO);
        case "registry.isApprovedForAll":
            return encode(execution.isOperator(args[0], args[1]));
        case "root.owner":
            return encode(state.root.owner);
        case "root.controllers":
            return encode(state.root.controllers.has(args[0]));
        case "root.locked":
            return encode(state.root.locked.has(args[0]));
        case "rr.owner":
            return encode(state.rr.owner);
        case "rr.controllers":
            return encode(state.rr.controllers.has(args[0]));
        case "rr.defaultResolver":
            return encode(state.rr.defaultResolver);
        case "fifs.available":
            return encode(execution.ownerView(W.subnode(state.fifs.baseNode, args[0])) === ZERO);
        case "resolver.addr":
            return encode(r.addrs.get(versioned(args[0])) ?? ZERO);
        case "resolver.text":
            return encode(r.texts.get(`${versioned(args[0])}:${args[1]}`) ?? "");
        case "resolver.contenthash":
            return encode(r.hashes.get(versioned(args[0])) ?? "");
        case "resolver.name":
            return encode(r.names.get(versioned(args[0])) ?? "");
        case "resolver.recordVersions":
            return encode(execution.version(args[0]));
        case "rr.node":
            return encode(W.reverseNode(args[0]));
        case "root.qns":
        case "root.ens":
            return encode(state.root.qns);
        case "rr.qns":
        case "rr.ens":
            return encode(state.rr.qns);
        case "fifs.qns":
        case "fifs.ens":
            return encode(state.fifs.qns);
        case "fifs.baseNode":
            return encode(state.fifs.baseNode);
        case "resolver.qns":
        case "resolver.ens":
            return encode(r.qns);
        case "resolver.trustedReverseRegistrar":
            return encode(r.trusted);
        case "root.supportsInterface":
            return encode(args[0] === "01ffc9a7");
        case "resolver.supportsInterface":
            return encode(RESOLVER_INTERFACES.has(args[0]));
        default:
            throw new Error(`model: unsupported view ${target}.${fn}`);
    }
}

module.exports = { MUTATIONS, Revert, UINT64_MAX, applyStep, emptyState, setMutation, viewOutput };
