const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    isLoopbackRpcUrl,
    loadDeployerFromEnvironment,
    loadBehaviorCounterparty,
    parsePublicDevSeeds,
    publicDevChainId,
} = require("../../scripts/lib/loadDeployer");

test("rejects public fixture selectors on private v3 even through loopback", () => {
    assert.throws(() => loadDeployerFromEnvironment({}, {
        repoRoot: "/unused",
        rpcUrl: "http://127.0.0.1:32002",
        chainId: 3151909,
        env: { QNS_PUBLIC_DEV_ACCOUNT: "0", QNS_PUBLIC_DEV_CHAIN_ID: "3151909" },
    }), /restricted to the local Kurtosis/);
});

test("private behavior tests require a separately supplied owned counterparty", () => {
    const options = { repoRoot: "/unused", rpcUrl: "https://rpc.example.test", chainId: 3151909, env: {} };
    assert.throws(() => loadBehaviorCounterparty({}, options), /QNS_BEHAVIOR_SECOND_SEED/);
    const account = { address: `Q${"12".repeat(64)}` };
    const web3 = { qrl: { accounts: {
        seedToAccount: () => account,
        wallet: { add: () => {} },
    } } };
    assert.equal(loadBehaviorCounterparty(web3, {
        ...options,
        env: { QNS_BEHAVIOR_SECOND_SEED: "01".repeat(51) },
    }), account);
});

test("parses public development seeds from the Kurtosis fixture", () => {
    const firstSeed = "01".repeat(51);
    const secondSeed = "ab".repeat(51);
    const source = `
        new_prefunded_account(
            "Q${"12".repeat(64)}",
            "${firstSeed}",
        ),
        new_prefunded_account("Q${"34".repeat(64)}", "${secondSeed}"),
    `;

    assert.deepEqual(parsePublicDevSeeds(source), [firstSeed, secondSeed]);
});

test("recognizes only loopback RPC URLs", () => {
    assert.equal(isLoopbackRpcUrl("http://127.0.0.1:32002"), true);
    assert.equal(isLoopbackRpcUrl("http://localhost:32002"), true);
    assert.equal(isLoopbackRpcUrl("http://[::1]:32002"), true);
    assert.equal(isLoopbackRpcUrl("https://testnet.example:32002"), false);
    assert.equal(isLoopbackRpcUrl("not a URL"), false);
});

test("uses the pinned default or one explicit local development chain ID", () => {
    assert.equal(publicDevChainId({}), 3151908);
    assert.equal(publicDevChainId({ QNS_PUBLIC_DEV_CHAIN_ID: "3151911" }), 3151911);

    for (const value of ["0", "-1", "01", "1.5", "abc", "9007199254740992"]) {
        assert.throws(
            () => publicDevChainId({ QNS_PUBLIC_DEV_CHAIN_ID: value }),
            /positive/
        );
    }
});

test("explicit local public account overrides a configured private seed", (t) => {
    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "qns-public-fixture-"));
    t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }));

    const constantsDir = path.join(
        packageDir,
        "src",
        "prelaunch_data_generator",
        "genesis_constants"
    );
    fs.mkdirSync(constantsDir, { recursive: true });
    const publicSeed = "01".repeat(51);
    fs.writeFileSync(
        path.join(constantsDir, "genesis_constants.star"),
        `new_prefunded_account("Q${"12".repeat(64)}", "${publicSeed}")\n`
    );

    const selectedSeeds = [];
    const wallet = { add() {} };
    const web3 = {
        qrl: {
            accounts: {
                seedToAccount(seed) {
                    selectedSeeds.push(seed);
                    return { address: `Q${"34".repeat(64)}` };
                },
                wallet,
            },
            wallet,
        },
    };

    loadDeployerFromEnvironment(web3, {
        repoRoot: packageDir,
        rpcUrl: "http://127.0.0.1:32002",
        chainId: 3151908,
        env: {
            QNS_PUBLIC_DEV_ACCOUNT: "0",
            QRL_PACKAGE_DIR: packageDir,
            TESTNET_SEED: `0x${"ab".repeat(51)}`,
        },
    });

    assert.deepEqual(selectedSeeds, [`0x${publicSeed}`]);
});

test("public account selector refuses a non-loopback RPC URL", () => {
    assert.throws(
        () =>
            loadDeployerFromEnvironment({}, {
                repoRoot: os.tmpdir(),
                rpcUrl: "https://testnet.example:32002",
                chainId: 3151908,
                env: { QNS_PUBLIC_DEV_ACCOUNT: "0" },
            }),
        /restricted to the local Kurtosis network/
    );
});

test("public account selector refuses a foreign chain ID", () => {
    assert.throws(
        () =>
            loadDeployerFromEnvironment({}, {
                repoRoot: os.tmpdir(),
                rpcUrl: "http://127.0.0.1:32002",
                chainId: 1337,
                env: { QNS_PUBLIC_DEV_ACCOUNT: "0" },
            }),
        /restricted to the local Kurtosis network/
    );
});

test("public account selector accepts an explicitly pinned local chain ID", (t) => {
    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "qns-public-chain-"));
    t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }));

    const constantsDir = path.join(
        packageDir,
        "src",
        "prelaunch_data_generator",
        "genesis_constants"
    );
    fs.mkdirSync(constantsDir, { recursive: true });
    const publicSeed = "01".repeat(51);
    fs.writeFileSync(
        path.join(constantsDir, "genesis_constants.star"),
        `new_prefunded_account("Q${"12".repeat(64)}", "${publicSeed}")\n`
    );

    const selectedSeeds = [];
    const wallet = { add() {} };
    const web3 = {
        qrl: {
            accounts: {
                seedToAccount(seed) {
                    selectedSeeds.push(seed);
                    return { address: `Q${"34".repeat(64)}` };
                },
                wallet,
            },
            wallet,
        },
    };

    loadDeployerFromEnvironment(web3, {
        repoRoot: packageDir,
        rpcUrl: "http://127.0.0.1:32012",
        chainId: 3151911,
        env: {
            QNS_PUBLIC_DEV_ACCOUNT: "0",
            QNS_PUBLIC_DEV_CHAIN_ID: "3151911",
            QRL_PACKAGE_DIR: packageDir,
        },
    });

    assert.deepEqual(selectedSeeds, [`0x${publicSeed}`]);
});

test("public account selector validates the index format", () => {
    for (const badIndex of ["abc", "-1", "01", "1.5"]) {
        assert.throws(
            () =>
                loadDeployerFromEnvironment({}, {
                    repoRoot: os.tmpdir(),
                    rpcUrl: "http://127.0.0.1:32002",
                    chainId: 3151908,
                    env: { QNS_PUBLIC_DEV_ACCOUNT: badIndex },
                }),
            /non-negative integer/
        );
    }
});

test("public account selector rejects an out-of-range index", (t) => {
    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "qns-public-range-"));
    t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }));

    const constantsDir = path.join(
        packageDir,
        "src",
        "prelaunch_data_generator",
        "genesis_constants"
    );
    fs.mkdirSync(constantsDir, { recursive: true });
    fs.writeFileSync(
        path.join(constantsDir, "genesis_constants.star"),
        `new_prefunded_account("Q${"12".repeat(64)}", "${"01".repeat(51)}")\n`
    );

    assert.throws(
        () =>
            loadDeployerFromEnvironment({}, {
                repoRoot: packageDir,
                rpcUrl: "http://127.0.0.1:32002",
                chainId: 3151908,
                env: { QNS_PUBLIC_DEV_ACCOUNT: "5", QRL_PACKAGE_DIR: packageDir },
            }),
        /absent from/
    );
});

test("a seed that is neither hex nor a 34-word mnemonic is rejected", () => {
    assert.throws(
        () =>
            loadDeployerFromEnvironment({}, {
                repoRoot: os.tmpdir(),
                rpcUrl: "http://127.0.0.1:32002",
                chainId: 3151908,
                env: { TESTNET_SEED: "definitely not a seed" },
            }),
        /34-word ML-DSA-87 mnemonic/
    );
});

test("throws when no deployer secret is configured at all", () => {
    assert.throws(
        () =>
            loadDeployerFromEnvironment({}, {
                repoRoot: os.tmpdir(),
                rpcUrl: "http://127.0.0.1:32002",
                chainId: 3151908,
                env: {},
            }),
        /Set TESTNET_SEED/
    );
});
