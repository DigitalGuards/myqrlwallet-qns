// Usage: QNS_CONFIG=config/testnet-v3.json npm run handoff -- --dry-run
const path = require("node:path");
const { Web3 } = require("@theqrl/web3");
const { loadDeployerFromEnvironment } = require("./lib/loadDeployer");
const { assertGovernanceNetwork, loadGovernanceConfig } = require("./lib/governance");
const { runHandoff } = require("./lib/handoff");

async function main(argv = process.argv.slice(2)) {
    if (argv.some((arg) => arg !== "--dry-run")) throw new Error("Usage: handoff.js [--dry-run]");
    const dryRun = argv.includes("--dry-run");
    const repoRoot = path.resolve(__dirname, "..");
    if (!dryRun) require("dotenv").config({ path: path.join(repoRoot, ".env") });
    const config = await loadGovernanceConfig(process.env.QNS_CONFIG);
    const web3 = new Web3(config.rpcUrl);
    const chainId = await assertGovernanceNetwork(web3, config);
    const account = dryRun ? undefined : loadDeployerFromEnvironment(web3, { repoRoot, rpcUrl: config.rpcUrl, chainId });
    return runHandoff({ web3, config, account, dryRun });
}

if (require.main === module) main().catch((error) => {
    console.error("Handoff failed:", error.message);
    process.exitCode = 1;
});

module.exports = { main };
