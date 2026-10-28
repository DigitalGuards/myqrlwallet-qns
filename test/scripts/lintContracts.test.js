const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
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
