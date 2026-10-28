const test = require("node:test");
const assert = require("node:assert/strict");
const { Web3 } = require("@theqrl/web3");
const { loadSdk } = require("../../scripts/lib/sdk");
const { registrationHashes } = require("../../scripts/lib/registrationHashes");
const { main } = require("../../scripts/register-and-resolve");

for (const label of ["0xab", "alice", "0xAB", "ALIce"]) {
    test(`SDK hashes the ASCII characters of ${label} before registration`, async () => {
        const sdk = await loadSdk();
        const web3 = new Web3();
        const result = registrationHashes(label, "qrl", sdk, web3);
        const normalized = label.toLowerCase();
        assert.equal(result.labelHash, Web3.utils.keccak256(Web3.utils.utf8ToHex(normalized)));
        assert.equal(result.labelHash, sdk.registrationName(label).labelHash);
        assert.equal(result.node, sdk.registrationName(label).node);
        if (normalized === "0xab") assert.notEqual(result.labelHash, Web3.utils.keccak256(normalized));
    });
}

test("parity mismatch stops the registration entrypoint before signer loading or any transaction", async () => {
    const sdk = await loadSdk();
    let writes = 0;
    let signers = 0;
    const web3 = {
        utils: { utf8ToHex: Web3.utils.utf8ToHex, keccak256: () => `0x${"ff".repeat(32)}` },
        qrl: { sendTransaction: () => { writes++; } },
    };
    await assert.rejects(main({ sdk, config: { tld: "qrl" }, requestedLabel: "0xab", web3,
        loadAccount: () => { signers++; } }), /disagree before registration/);
    assert.equal(signers, 0);
    assert.equal(writes, 0);
});

test("rejects empty or multi-label inputs before hashing transactions", async () => {
    const sdk = await loadSdk();
    for (const label of ["", "alice.qrl", "bob.alice"]) {
        assert.throws(() => registrationHashes(label, "qrl", sdk, new Web3()), /one nonempty label/);
    }
});
