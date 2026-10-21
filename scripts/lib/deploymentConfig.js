const fs = require("node:fs");

// The selected deployment record must already exist and pass the browser's validator.
async function loadDeploymentConfig(configPath) {
    if (typeof configPath !== "string" || !configPath.trim()) {
        throw new Error("Set QNS_CONFIG to an existing target network configuration");
    }
    if (configPath.endsWith(".example.json")) {
        throw new Error("Select an ignored deployment config, such as config/testnet-v3.json");
    }
    if (!fs.existsSync(configPath)) {
        throw new Error("Create the requested deployment configuration first");
    }
    const { parseNetworkConfig } = await import("../../sdk/src/networkConfig.js");
    const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const config = parseNetworkConfig(value);
    if (Object.values(config.contracts).some((address) => address !== null)) {
        throw new Error("This configuration already has deployed contracts. Preserve it and select a fresh configuration for a new deployment.");
    }
    return { ...value, ...config };
}

module.exports = { loadDeploymentConfig };
