const test = require("node:test");
const assert = require("node:assert/strict");
const { assertNetworkIdentity, V3_GENESIS_HASH } = require("../../scripts/lib/networkIdentity");

test("pins private v3 chain and genesis independently", async () => {
    const config = require("../../config/testnet-v3.example.json");
    const web3 = { qrl: {
        getChainId: async () => 3151909n,
        getBlock: async () => ({ hash: V3_GENESIS_HASH }),
    } };
    assert.equal(await assertNetworkIdentity(web3, config), 3151909n);
    await assert.rejects(() => assertNetworkIdentity(web3, { ...config, genesisHash: undefined }), /pinned genesis/);
    web3.qrl.getBlock = async () => ({ hash: `0x${"ff".repeat(32)}` });
    await assert.rejects(() => assertNetworkIdentity(web3, config), /genesis hash mismatch/);
    web3.qrl.getChainId = async () => 1337n;
    await assert.rejects(() => assertNetworkIdentity(web3, config), /chainId mismatch/);
});

test("keeps explicit local fixture networks loopback scoped", async () => {
    const config = { chainId: 3151908, rpcUrl: "http://127.0.0.1:32002" };
    const web3 = { qrl: { getChainId: async () => 3151908n } };
    assert.equal(await assertNetworkIdentity(web3, config), 3151908n);
    await assert.rejects(() => assertNetworkIdentity(web3, { ...config, rpcUrl: "https://rpc.example.test" }), /genesisHash/);
    await assert.rejects(() => assertNetworkIdentity(web3, { ...config, rpcUrl: "http://user:password@127.0.0.1" }), /credentials/);
});
