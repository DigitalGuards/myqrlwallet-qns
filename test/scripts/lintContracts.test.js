const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    KNOWN_BUG_RULES,
    PRAGMA,
    checkAllowlist,
    hyperionOnlyFindings,
    masked,
    sourceFindings,
    sourcesIn,
} = require("../../scripts/lint-contracts");

const contract = (body, pragma = PRAGMA) => `// SPDX-License-Identifier: GPL-3.0-or-later\n${pragma}\n\ncontract C {\n${body}\n}\n`;
const rulesOf = (source) => sourceFindings({ "contracts/C.hyp": { content: source } }).map((finding) => finding.rule);
const quiet = () => {};

function rejects(source, rule) {
    const findings = sourceFindings({ "contracts/C.hyp": { content: source } });
    assert.ok(findings.some((finding) => finding.rule === rule), `missing ${rule}: ${source}`);
    assert.throws(() => checkAllowlist(findings, [], "source", quiet), /without a reviewed allowlist entry/);
}

const bugRulesOf = (source) => rulesOf(source).filter((rule) => KNOWN_BUG_RULES.has(rule));

test("verifier-arguments rejects literals, expressions, calldata and storage for both verifiers", () => {
    for (const builtin of ["mldsa87verify", "xmssverify"]) {
        const args = builtin === "mldsa87verify" ? ["d", "sig", "key", "ctx"] : ["message", "sig", "key"];
        const declarations = `bytes64 d, bytes memory message, bytes memory sig, bytes memory key,
            bytes memory ctx, bytes calldata input`;
        const source = (values) => contract(`bytes private stored;
            function f(${declarations}) internal view returns (bool) {
                return ${builtin}(${values.join(", ")});
            }`);
        assert.deepEqual(bugRulesOf(source(args)), []);
        for (let position = 0; position < args.length; position++) {
            for (const expression of [
                '""', 'hex"0123"', 'unicode"abc"', "0", "stored", "input", "input[0:1]",
                "sig[0]", "this.stored", "makeBytes()", "abi.encode(sig)", "abi.encodePacked(sig, key)",
                "bytes.concat(sig, key)", "new bytes(1)", "true ? sig : key", "bytes64(message)",
            ]) {
                const values = [...args];
                values[position] = expression;
                rejects(source(values), "verifier-arguments");
            }
        }
    }
});

test("verifier-arguments requires an in-scope declaration completed before the call", () => {
    const wrap = (body) => contract(`bytes private sig;
        function f(bytes64 d, bytes memory key, bytes memory ctx, bytes calldata input) internal view returns (bool) {
            ${body}
        }`);
    for (const body of [
        "return mldsa87verify(d, sig, key, ctx); bytes memory sig = input;",
        "{ bytes memory sig = input; } return mldsa87verify(d, sig, key, ctx);",
        "bytes storage aliasSig = sig; return mldsa87verify(d, aliasSig, key, ctx);",
        "bytes calldata aliasSig = input; return mldsa87verify(d, aliasSig, key, ctx);",
        "for (bytes memory sig = input; false;) {} return mldsa87verify(d, sig, key, ctx);",
        "try this.loadBytes() returns (bytes memory sig) {} catch {} return mldsa87verify(d, sig, key, ctx);",
        "try this.loadBytes() {} catch (bytes memory sig) {} return mldsa87verify(d, sig, key, ctx);",
        "return mldsa87verify(d, bytes, key, ctx);",
    ]) rejects(wrap(body), "verifier-arguments");
    assert.deepEqual(bugRulesOf(wrap(`bytes memory copy = input;
        return mldsa87verify(d, /* materialized */ copy, key, ctx);`)), []);
    rejects(contract(`function g(bytes memory sig) internal pure {}
        function f(bytes64 d, bytes memory key, bytes memory ctx) internal pure returns (bool) {
            return mldsa87verify(d, sig, key, ctx);
        }`), "verifier-arguments");
    rejects(contract(`modifier verified(bytes64 d, bytes calldata sig, bytes memory key, bytes memory ctx) {
        require(mldsa87verify(d, sig, key, ctx)); _;
    }`), "verifier-arguments");
    rejects(contract(`constructor(bytes64 d, bytes memory sig, bytes memory key) {
        require(mldsa87verify(d, sig, key, ""));
    }`), "verifier-arguments");
    rejects(contract(`bytes private sig;
        function f(function(bytes memory sig) internal callback, bytes64 d, bytes memory key, bytes memory ctx)
            internal view returns (bool) { return mldsa87verify(d, sig, key, ctx); }`), "verifier-arguments");
    assert.deepEqual(bugRulesOf(wrap(`try this.loadBytes() returns (bytes memory copy) {
        return mldsa87verify(d, copy, key, ctx);
    } catch { return false; }`)), []);
});

test("delete-memory-bytes rejects memory byte element deletion and accepts zero assignment", () => {
    for (const expression of ["b[i]", "(b[i])", "((b))[i]"]) {
        rejects(contract(`function f(bytes memory b, uint256 i) internal pure { delete ${expression}; }`), "delete-memory-bytes");
    }
    rejects(contract(`function f(bytes memory b) internal pure {
        bytes memory aliasBytes = b; delete aliasBytes[0];
    }`), "delete-memory-bytes");
    rejects(contract(`function f(bytes[] memory list) internal pure { delete list[0][1]; }`), "delete-memory-bytes");
    rejects(contract(`struct Data { bytes value; }
        function f(Data memory data) internal pure { delete data.value[0]; }`), "delete-memory-bytes");
    rejects(contract(`function f() internal pure { delete makeBytes()[0]; }`), "delete-memory-bytes");
    for (const body of [
        "function f(bytes memory b) internal pure { b[0] = 0; }",
        "function f(bytes memory b) internal pure { delete b; }",
        "function f(bytes storage b) internal { delete b[0]; }",
        "function f(uint256[] memory b) internal pure { delete b[0]; }",
        "function f(bytes[] memory b) internal pure { delete b[0]; }",
    ]) assert.deepEqual(bugRulesOf(contract(body)), [], body);
});

test("storage-internal-function rejects state, array, mapping, struct and storage reference types", () => {
    for (const body of [
        "function() internal callback;",
        "function() callback;",
        "function(uint256) internal returns (uint256) private callback;",
        "function() internal[] private callbacks;",
        "mapping(uint256 => function() internal) private callbacks;",
        "struct Entry { function() internal callback; uint256 packed; } Entry private entry;",
        "function f(function() internal[] storage callbacks) internal {}",
        "function f() internal { function() internal[] storage callbacks = storedCallbacks; }",
    ]) rejects(contract(body), "storage-internal-function");
    for (const body of [
        "function() external private callback;",
        "function() external view returns (uint256) private callback;",
        "function() external pure returns (uint256) private callback;",
        "function() external payable private callback;",
        "function f(function() internal callback) internal { callback(); }",
        "function f() internal { function() internal callback = f; callback(); }",
        "function f(function() internal[] memory callbacks) internal {}",
        "function f() internal returns (function() internal callback) { return f; }",
    ]) assert.deepEqual(bugRulesOf(contract(body)), [], body);
});

test("depositroot-storage rejects state and storage aliases in every argument position", () => {
    const source = (args) => contract(`bytes private stored; mapping(uint256 => bytes) private records;
        struct Data { bytes value; } Data private data;
        function f(bytes memory a, bytes memory b, bytes memory c, bytes memory d) internal view returns (bytes32) {
            bytes storage aliasBytes = stored;
            return depositroot(${args.join(", ")});
        }`);
    const args = ["a", "b", "c", "d"];
    for (let position = 0; position < args.length; position++) {
        for (const expression of ["stored", "aliasBytes", "records[0]", "data.value", "storageBytes()", "trueContext"]) {
            const values = [...args];
            values[position] = expression;
            rejects(source(values), "depositroot-storage");
        }
    }
    assert.deepEqual(bugRulesOf(source(args)), []);
    assert.deepEqual(bugRulesOf(source([...args, "a"])), []);
    assert.deepEqual(bugRulesOf(contract(`bytes private stored;
        function f(bytes calldata b, bytes memory c, bytes memory d) internal view returns (bytes32) {
            bytes memory copy = stored;
            return depositroot(copy, b, c, d);
        }`)), []);
    assert.deepEqual(bugRulesOf(contract(`function f() internal pure returns (bytes32) {
        return depositroot("a", hex"12", "c", "d");
    }`)), []);
});

test("stale-returndatasize rejects captured sizes across external and Yul helper calls", () => {
    const source = (body) => contract(`function f() internal { assembly { ${body} } }`);
    const externalCalls = [
        "call(gas(), 1, 0, 0, 0, 0, 0)", "callcode(gas(), 1, 0, 0, 0, 0, 0)",
        "staticcall(gas(), 1, 0, 0, 0, 0)", "delegatecall(gas(), 1, 0, 0, 0, 0)",
        "create(0, 0, 0)", "create2(0, 0, 0, 0)",
    ];
    for (const call of externalCalls) {
        for (const capture of ["let size := returndatasize()", "let size size := returndatasize()", "let size := add(returndatasize(), 0)"]) {
            rejects(source(`${capture} pop(${call}) returndatacopy(0, 0, size)`), "stale-returndatasize");
        }
    }
    rejects(source(`function invoke() { pop(call(gas(), 1, 0, 0, 0, 0, 0)) }
        let size := returndatasize() invoke() returndatacopy(0, 0, size)`), "stale-returndatasize");
    rejects(source(`let size := 0 for {} 1 {} {
        pop(call(gas(), 1, 0, 0, 0, 0, 0)) returndatacopy(0, 0, size) size := returndatasize()
    }`), "stale-returndatasize");
    rejects(source(`let size := add(call(gas(), 1, 0, 0, 0, 0, 0), returndatasize())
        returndatacopy(0, 0, size)`), "stale-returndatasize");
    rejects(contract(`function f(address target) internal {
        uint256 size;
        assembly { size := returndatasize() }
        (bool ok,) = target.call(""); require(ok);
        assembly { returndatacopy(0, 0, size) }
    }`), "stale-returndatasize");
    rejects(contract(`function f() internal {
        uint256 size;
        assembly { size := returndatasize() }
        assembly { pop(call(gas(), 1, 0, 0, 0, 0, 0)) returndatacopy(0, 0, size) }
    }`), "stale-returndatasize");
    for (const body of [
        "pop(call(gas(), 1, 0, 0, 0, 0, 0)) let size := returndatasize() returndatacopy(0, 0, size)",
        "let size := returndatasize() returndatacopy(0, 0, size)",
        "pop(call(gas(), 1, 0, 0, 0, 0, 0)) returndatacopy(0, 0, returndatasize())",
    ]) assert.deepEqual(bugRulesOf(source(body)), [], body);
    const findings = sourceFindings({ "contracts/C.hyp": { content: source(`let size := returndatasize()
        pop(call(gas(), 1, 0, 0, 0, 0, 0)) returndatacopy(0, 0, size)`) } });
    const assembly = findings.find((finding) => finding.rule === "assembly");
    assert.throws(() => checkAllowlist(findings, [{ ...assembly, reason: "Assembly reviewed with a dedicated semantic regression." }], "source", quiet), /without a reviewed/);
});

test("unchecked-constant rejects non-literal reads and accepts checked staging or literal constants", () => {
    for (const initializer of ["type(uint256).max + 1", "uint256(1)", "1 + 2", "OTHER", 'keccak256("context")']) {
        rejects(contract(`uint256 private constant K = ${initializer};
            function f() internal pure returns (uint256) { unchecked { if (true) { return K; } } }`), "unchecked-constant");
    }
    for (const initializer of ["1", "0x12", "1_000", "1e3"]) {
        assert.deepEqual(bugRulesOf(contract(`uint256 private constant K = ${initializer};
            function f() internal pure returns (uint256) { unchecked { return K; } }`)), []);
    }
    assert.deepEqual(bugRulesOf(contract(`uint256 private constant K = type(uint256).max;
        function f() internal pure returns (uint256) { uint256 value = K; unchecked { return value; } }`)), []);
    assert.deepEqual(bugRulesOf(contract(`bytes32 private constant K = keccak256("context");
        function f(uint256 K) internal pure returns (uint256) { unchecked { return K; } }`)), []);
    assert.deepEqual(bugRulesOf(contract(`string private constant K = "} ; call()";
        function f() internal pure returns (string memory) { unchecked { return K; } }`)), []);
    rejects(contract(`function f(bytes memory b) internal pure { unchecked { delete b[0]; } }`), "delete-memory-bytes");
    const sources = {
        "contracts/Constants.hyp": { content: `${PRAGMA} uint256 constant K = type(uint256).max + 1;
            library Limits { uint256 internal constant MAX = type(uint256).max; }` },
        "contracts/C.hyp": { content: `${PRAGMA} import { K as RENAMED, Limits } from "./Constants.hyp";
            contract C { function f() internal pure returns (uint256) { unchecked { return RENAMED + Limits.MAX; } } }` },
    };
    assert.equal(sourceFindings(sources).filter((finding) => finding.rule === "unchecked-constant").length, 2);
});

test("known-bug guards ignore comments and strings and preserve diagnostic locations", () => {
    const decoys = 'mldsa87verify(0, "", "", "") delete b[0] function() internal cb; depositroot(s,s,s,s) unchecked { K; } assembly { let n := returndatasize() pop(call(0,0,0,0,0,0,0)) }';
    assert.deepEqual(bugRulesOf(contract(`/* ${decoys} */
        function f() internal pure returns (string memory) { return ${JSON.stringify(decoys)}; } // ${decoys}`)), []);
    const content = contract(`function f(bytes memory b) internal pure {
        // A comment keeps this diagnostic on its source line.
        delete b[0];
    }`);
    const finding = sourceFindings({ "contracts/C.hyp": { content } }).find((item) => item.rule === "delete-memory-bytes");
    assert.equal(finding.line, content.slice(0, content.indexOf("delete b")).split("\n").length);
    assert.match(finding.fingerprint, /^[a-f0-9]{64}$/);
});

test("all six known-bug guards have zero findings in repository contracts and cannot be allowlisted", () => {
    assert.equal(KNOWN_BUG_RULES.size, 6);
    assert.deepEqual(sourceFindings(sourcesIn()).filter((finding) => KNOWN_BUG_RULES.has(finding.rule)), []);
    for (const rule of KNOWN_BUG_RULES) {
        assert.throws(() => checkAllowlist([], [{ rule }], "source", quiet), /cannot be allowlisted/);
    }
});

test("masking keeps offsets and blanks comments and literals", () => {
    const source = 'uint x; // tx.origin\nstring s = "assembly { }"; /* call( */';
    const result = masked(source);
    assert.equal(result.length, source.length);
    assert.doesNotMatch(result, /tx\.origin|assembly|call\(/);
    assert.match(result, /uint x;/);
});

test("pragma policy requires exactly one pinned Hyperion pragma", () => {
    assert.deepEqual(rulesOf(contract("")), []);
    assert.deepEqual(rulesOf(contract("", "pragma solidity ^0.8.0;")), ["pragma"]);
    assert.deepEqual(rulesOf(contract("", `${PRAGMA}\npragma experimental SMTChecker;`)), ["pragma"]);
    assert.deepEqual(rulesOf(contract("", "")), ["pragma"]);
});

test("tx.origin and inline assembly are reported, comments and strings are not", () => {
    assert.deepEqual(rulesOf(contract("function f() external view returns (address) { return tx.origin; }")), ["tx-origin"]);
    assert.deepEqual(
        rulesOf(contract("function f() external pure returns (uint256 r) { assembly { r := 1 } }")),
        ["assembly"]
    );
    assert.deepEqual(
        rulesOf(contract('function f() external pure returns (string memory) { return "tx.origin assembly"; } // tx.origin')),
        []
    );
});

test("unchecked low-level call results are reported", () => {
    const emit = "event E(); ";
    const unchecked = [
        "function f(address t) external { t.call(\"\"); emit E(); }",
        "function f(address payable t) external { t.send(1); emit E(); }",
        "function f(address t) external { (bool ok, ) = t.call(\"\"); emit E(); }",
        "function f(address t) external { t.delegatecall(\"\"); emit E(); }",
    ];
    for (const body of unchecked) assert.deepEqual(rulesOf(contract(emit + body)), ["low-level-call"], body);
    const checked = [
        "function f(address t) external { (bool ok, ) = t.call(\"\"); require(ok); emit E(); }",
        "function f(address t) external { (bool ok, bytes memory r) = t.call{value: 0}(\"\"); if (!ok) revert(); emit E(); }",
        "function f(address payable t) external { require(t.send(1)); emit E(); }",
        "function f(address t) external returns (bool) { emit E(); return t.call(\"\") == t.call(\"\"); }",
        "function f(address t) external { bool ok; (ok, ) = t.staticcall(\"\"); assert(ok); emit E(); }",
    ];
    for (const body of checked) assert.deepEqual(rulesOf(contract(emit + body)), [], body);
});

test("implicit visibility is reported for state variables", () => {
    assert.deepEqual(rulesOf(contract("uint256 counter;")), ["visibility"]);
    assert.deepEqual(rulesOf(contract("uint256 internal counter; uint256 private constant K = 1;")), []);
});

test("state-changing public functions must emit directly or through a local helper", () => {
    assert.deepEqual(rulesOf(contract("uint256 private x; function f() external { x = 1; }")), ["event"]);
    assert.deepEqual(rulesOf(contract("event E(); uint256 private x; function f() external { x = 1; emit E(); }")), []);
    assert.deepEqual(
        rulesOf(contract("event E(); function g() internal { emit E(); } function f() public { g(); }")),
        []
    );
    assert.deepEqual(
        rulesOf(contract("event E(); function f() external view returns (uint256) { return 1; }")),
        []
    );
    // A member call to another contract does not count as a local helper.
    assert.deepEqual(rulesOf(contract("function f(C other) external { other.g(); } function g() external {}")), [
        "event",
        "event",
    ]);
});

test("allowlist entries need a reason, match exactly, and go stale when unused", () => {
    const finding = { rule: "event", file: "contracts/C.hyp", line: 1, fingerprint: "ab", detail: "d" };
    const entry = { rule: "event", file: "contracts/C.hyp", fingerprint: "ab", reason: "Forwarded call; the callee emits the event." };
    assert.equal(checkAllowlist([finding], [entry], "t", quiet), 1);
    assert.throws(() => checkAllowlist([finding], [{ ...entry, reason: "" }], "t", quiet), /without a reviewed allowlist entry/);
    assert.throws(() => checkAllowlist([finding], [{ ...entry, fingerprint: "cd" }], "t", quiet), /without a reviewed/);
    assert.throws(() => checkAllowlist([], [entry], "t", quiet), /stale/);
});

test("the repository passes the source policy with the committed allowlist", () => {
    const allowlist = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "..", "config", "contract-lint-allowlist.json"), "utf8")
    );
    const findings = [...hyperionOnlyFindings(), ...sourceFindings(sourcesIn())];
    assert.equal(checkAllowlist(findings, allowlist.source, "source", quiet), allowlist.source.length);
    for (const entry of [...allowlist.source, ...allowlist.warnings]) {
        assert.ok(entry.reason.length >= 60, `allowlist reason too short for ${entry.file}:${entry.line}`);
        assert.doesNotMatch(entry.reason, /\u2014/, "allowlist reasons use no em dash");
    }
});

test("the Hyperion-only rule finds Solidity and Foundry files", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qns-lint-"));
    try {
        fs.mkdirSync(path.join(directory, "src"));
        fs.writeFileSync(path.join(directory, "src", "Token.sol"), "contract T {}");
        fs.writeFileSync(path.join(directory, "foundry.toml"), "");
        fs.mkdirSync(path.join(directory, "node_modules"));
        fs.writeFileSync(path.join(directory, "node_modules", "Dep.sol"), "contract D {}");
        const files = hyperionOnlyFindings(directory).map((finding) => path.basename(finding.file)).sort();
        assert.deepEqual(files, ["Token.sol", "foundry.toml"]);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
