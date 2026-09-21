// Adapted from the QuantaPool deployer loader (GPL-3.0).
// QRL 2.0 uses 34-word ML-DSA-87 mnemonics and 51-byte extended seeds.
const fs = require("fs");
const path = require("path");

const { MLDSA87 } = require("@theqrl/wallet.js");

const MNEMONIC_WORDS = 34;
const EXTENDED_SEED_HEX_LENGTH = 102;
const DEFAULT_LOCAL_KURTOSIS_CHAIN_ID = 3151908;

function loadDeployer(web3, secret) {
    const value = secret?.trim() || "";
    const rawHex = value.replace(/^0x/i, "");
    let seedHex;

    if (
        rawHex.length === EXTENDED_SEED_HEX_LENGTH &&
        /^[0-9a-fA-F]+$/.test(rawHex)
    ) {
        seedHex = `0x${rawHex}`;
    } else if (value.split(/\s+/).length === MNEMONIC_WORDS) {
        const wallet = MLDSA87.newWalletFromMnemonic(value);
        seedHex = wallet.getHexExtendedSeed();
    } else {
        throw new Error(
            `Deployer seed must be a ${MNEMONIC_WORDS}-word ML-DSA-87 mnemonic ` +
                `or a ${EXTENDED_SEED_HEX_LENGTH}-character extended-seed hex value.`
        );
    }

    const account = web3.qrl.accounts.seedToAccount(seedHex);
    web3.qrl.accounts.wallet.add(account);
    if (
        web3.qrl.wallet &&
        web3.qrl.wallet !== web3.qrl.accounts.wallet &&
        typeof web3.qrl.wallet.add === "function"
    ) {
        web3.qrl.wallet.add(seedHex);
    }
    return account;
}

function parsePublicDevSeeds(source) {
    const seeds = [];
    const pattern =
        /new_prefunded_account\(\s*"Q[0-9a-fA-F]{128}",\s*"([0-9a-fA-F]{102})",?\s*\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        seeds.push(match[1]);
    }
    return seeds;
}

function isLoopbackRpcUrl(rpcUrl) {
    let parsed;
    try {
        parsed = new URL(rpcUrl);
    } catch {
        return false;
    }
    return ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
}

function publicDevChainId(env = process.env) {
    const value = env.QNS_PUBLIC_DEV_CHAIN_ID?.trim();
    if (!value) {
        return DEFAULT_LOCAL_KURTOSIS_CHAIN_ID;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error("QNS_PUBLIC_DEV_CHAIN_ID must be a positive decimal integer");
    }
    const chainId = Number(value);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
        throw new Error("QNS_PUBLIC_DEV_CHAIN_ID must be a positive safe integer");
    }
    return chainId;
}

function loadPublicDevSeed(repoRoot, accountIndex, env = process.env) {
    if (!/^(0|[1-9][0-9]*)$/.test(accountIndex)) {
        throw new Error("QNS_PUBLIC_DEV_ACCOUNT must be a non-negative integer");
    }

    const packageDir = env.QRL_PACKAGE_DIR
        ? path.resolve(env.QRL_PACKAGE_DIR)
        : path.resolve(repoRoot, "..", "qrl-package");
    const constantsPath = path.join(
        packageDir,
        "src",
        "prelaunch_data_generator",
        "genesis_constants",
        "genesis_constants.star"
    );
    const seeds = parsePublicDevSeeds(fs.readFileSync(constantsPath, "utf8"));
    const index = Number(accountIndex);
    if (!seeds[index]) {
        throw new Error(
            `Public development account #${index} is absent from ${constantsPath}`
        );
    }
    return seeds[index];
}

function loadDeployerFromEnvironment(web3, options) {
    const { repoRoot, rpcUrl, chainId, env = process.env } = options;
    const publicDevAccount = env.QNS_PUBLIC_DEV_ACCOUNT?.trim();
    if (publicDevAccount) {
        const expectedChainId = publicDevChainId(env);
        if (Number(chainId) === 3151909 || !isLoopbackRpcUrl(rpcUrl) || Number(chainId) !== expectedChainId) {
            throw new Error(
                "QNS_PUBLIC_DEV_ACCOUNT is restricted to the local Kurtosis network " +
                    `(loopback RPC URL, chain ${expectedChainId})`
            );
        }
        const seed = loadPublicDevSeed(repoRoot, publicDevAccount, env);
        return loadDeployer(web3, seed);
    }

    if (env.TESTNET_SEED?.trim()) {
        return loadDeployer(web3, env.TESTNET_SEED);
    }

    throw new Error(
        "Set TESTNET_SEED, or select a published local Kurtosis account with " +
            "QNS_PUBLIC_DEV_ACCOUNT"
    );
}

function loadBehaviorCounterparty(web3, options) {
    const env = options.env || process.env;
    if (env.QNS_BEHAVIOR_SECOND_SEED?.trim()) {
        return loadDeployer(web3, env.QNS_BEHAVIOR_SECOND_SEED);
    }
    if (!env.QNS_PUBLIC_DEV_ACCOUNT?.trim()) {
        throw new Error("Set QNS_BEHAVIOR_SECOND_SEED for the owned private-network test counterparty");
    }
    return loadDeployerFromEnvironment(web3, {
        ...options,
        env: {
            ...env,
            QNS_PUBLIC_DEV_ACCOUNT: env.QNS_BEHAVIOR_SECOND_ACCOUNT || "1",
        },
    });
}

module.exports = {
    isLoopbackRpcUrl,
    loadDeployer,
    loadDeployerFromEnvironment,
    loadBehaviorCounterparty,
    loadPublicDevSeed,
    parsePublicDevSeeds,
    publicDevChainId,
};
