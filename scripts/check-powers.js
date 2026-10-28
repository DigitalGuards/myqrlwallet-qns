// Read-only: QNS_CONFIG=config/testnet-v3.json npm run check:powers -- --report-only
const { Web3 } = require("@theqrl/web3");
const { loadGovernanceConfig } = require("./lib/governance");
const { checkPowers } = require("./lib/checkPowers");
const { printError } = require("./lib/errors");

async function main(argv = process.argv.slice(2)) {
    if (argv.some((arg) => arg !== "--report-only")) throw new Error("Usage: check-powers.js [--report-only]");
    const config = await loadGovernanceConfig(process.env.QNS_CONFIG);
    const report = await checkPowers({ web3: new Web3(config.rpcUrl), config, reportOnly: argv.includes("--report-only") });
    process.exitCode = report.exitCode;
    return report;
}

if (require.main === module) main().catch((error) => {
    printError("Power check failed:", error);
    process.exitCode = 1;
});

module.exports = { main };
