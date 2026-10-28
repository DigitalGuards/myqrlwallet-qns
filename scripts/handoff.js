// Usage: QNS_CONFIG=config/testnet-v3.json npm run handoff -- --dry-run
const path = require("node:path");
const fs = require("node:fs");
const { Web3 } = require("@theqrl/web3");
const { loadDeployerFromEnvironment } = require("./lib/loadDeployer");
const { loadGovernanceConfig } = require("./lib/governance");
const { runHandoff } = require("./lib/handoff");
const { printError } = require("./lib/errors");

function parseArguments(argv) {
    if (argv.length === 0 || (argv.length === 1 && argv[0] === "--dry-run")) return { dryRun: true };
    const hash = argv.length === 2 && argv[0] === "--execute" ? argv[1]
        : argv.length === 1 && argv[0].startsWith("--execute=") ? argv[0].slice(10) : null;
    if (hash && /^[0-9a-fA-F]{64}$/.test(hash)) return { dryRun: false, executeHash: hash.toLowerCase() };
    throw new Error("Usage: handoff.js [--dry-run | --execute <hash> | --execute=<hash>]");
}

async function main(argv = process.argv.slice(2)) {
    const selector = process.env.QNS_CONFIG;
    const mode = parseArguments(argv);
    if (process.env.npm_config_dry_run === "true") {
        console.log("npm consumed --dry-run; execution is refused. Running as a dry run.");
        mode.dryRun = true;
    }
    const repoRoot = path.resolve(__dirname, "..");
    const config = await loadGovernanceConfig(selector);
    const web3 = new Web3(config.rpcUrl);
    const loadAccount = (chainId) => {
        let fileEnv = {};
        try {
            fileEnv = require("dotenv").parse(fs.readFileSync(path.join(repoRoot, ".env")));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        const env = {};
        for (const name of ["TESTNET_SEED", "QNS_PUBLIC_DEV_ACCOUNT", "QNS_PUBLIC_DEV_CHAIN_ID"]) {
            const value = process.env[name] ?? fileEnv[name];
            if (value !== undefined) env[name] = value;
        }
        return loadDeployerFromEnvironment(web3, { repoRoot, rpcUrl: config.rpcUrl, chainId, env });
    };
    return runHandoff({ web3, config, loadAccount, ...mode });
}

if (require.main === module) main().catch((error) => {
    printError("Handoff failed:", error);
    process.exitCode = 1;
});

module.exports = { main, parseArguments };
