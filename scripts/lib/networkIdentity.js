const V3_CHAIN_ID = 3151909n;
const V3_GENESIS_HASH = "0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4";

async function assertNetworkIdentity(web3, config) {
    if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) {
        throw new Error("Deployment config requires a positive safe chainId");
    }
    const rpc = new URL(config.rpcUrl);
    if (!["http:", "https:"].includes(rpc.protocol) || rpc.username || rpc.password) {
        throw new Error("Deployment RPC must use HTTP(S) without embedded credentials");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
    const expectedChainId = BigInt(config.chainId);
    const expectedGenesis = config.genesisHash;
    if (expectedChainId === V3_CHAIN_ID && expectedGenesis !== V3_GENESIS_HASH) {
        throw new Error("Testnet v3 requires the pinned genesis hash");
    }
    if ((!loopback || expectedGenesis !== undefined) && !/^0x[0-9a-f]{64}$/.test(expectedGenesis || "")) {
        throw new Error("Deployment config requires an explicit genesisHash");
    }
    const chainId = BigInt(await web3.qrl.getChainId());
    if (chainId !== expectedChainId) throw new Error("chainId mismatch");
    if (expectedGenesis !== undefined) {
        const genesis = await web3.qrl.getBlock("0x0", false);
        if (typeof genesis?.hash !== "string" || genesis.hash.toLowerCase() !== expectedGenesis) {
            throw new Error("genesis hash mismatch");
        }
    }
    return chainId;
}

module.exports = { assertNetworkIdentity, V3_CHAIN_ID, V3_GENESIS_HASH };
