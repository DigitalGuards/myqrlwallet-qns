// Copied from ../../QuantaPool/scripts/lib/loadDeployer.js (GPL-3.0).
// wallet.js v3 bumped the mnemonic length from 32 to 34 words; guard against
// stale seeds.
const { MLDSA87 } = require("@theqrl/wallet.js");

const MNEMONIC_WORDS = 34;

function loadDeployer(web3, mnemonic) {
    if (!mnemonic || mnemonic.trim().split(/\s+/).length !== MNEMONIC_WORDS) {
        throw new Error(
            `Deployer mnemonic must be ${MNEMONIC_WORDS} words. ` +
                `wallet.js v3 changed mnemonic length from 32 to ${MNEMONIC_WORDS}; regenerate the seed.`
        );
    }
    const wallet = MLDSA87.newWalletFromMnemonic(mnemonic);
    const seedHex = wallet.getHexExtendedSeed();
    const account = web3.qrl.accounts.seedToAccount(seedHex);
    web3.qrl.accounts.wallet.add(account);
    if (web3.qrl.wallet && typeof web3.qrl.wallet.add === "function") {
        web3.qrl.wallet.add(seedHex);
    }
    return account;
}

module.exports = { loadDeployer };
