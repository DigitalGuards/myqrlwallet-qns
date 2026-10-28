const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Use the SDK's existing hash and 64-byte ABI implementation in Node scripts.
async function loadSdk() {
    const dist = path.resolve(__dirname, "../../sdk/dist");
    const [sdk, abi] = await Promise.all([
        import(pathToFileURL(path.join(dist, "index.js")).href),
        import(pathToFileURL(path.join(dist, "abi.js")).href),
    ]);
    return { ...sdk, abi };
}

module.exports = { loadSdk };
