const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
    isLoopbackRpcUrl,
    loadDeployerFromEnvironment,
    parsePublicDevSeeds,
} = require("../../scripts/lib/loadDeployer");

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
