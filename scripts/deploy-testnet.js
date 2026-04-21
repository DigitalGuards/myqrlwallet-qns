// Deploy QNS Phase 1 contract stack to QRL Zond Testnet V2.
// Uses Foundry-compiled bytecode (out/*.json) directly via @theqrl/web3.
//
// Usage:
//   npm run compile            # forge build, produces out/
//   npm run deploy:testnet     # reads config/testnet.json, writes back addresses
//
// Requires TESTNET_SEED in .env (34-word ML-DSA-87 mnemonic).

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Web3 } = require("@theqrl/web3");
const { loadDeployer } = require("./lib/loadDeployer");

const repoRoot = path.join(__dirname, "..");
const configPath = path.join(repoRoot, "config", "testnet.json");
const outDir = path.join(repoRoot, "out");

function loadJson(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadArtifact(contractName) {
    // Foundry output is at out/<file>.sol/<ContractName>.json, file name
    // matches the Solidity file basename.
    const candidates = [
        `${contractName}.sol/${contractName}.json`,
    ];
    for (const relPath of candidates) {
        const artifactPath = path.join(outDir, relPath);
        if (fs.existsSync(artifactPath)) {
            const artifact = loadJson(artifactPath);
            if (!artifact.bytecode || !artifact.bytecode.object) {
                throw new Error(`Artifact ${relPath} has no bytecode.object`);
            }
            return {
                abi: artifact.abi,
                bytecode: artifact.bytecode.object,
            };
        }
    }
    throw new Error(
        `Foundry artifact not found for ${contractName}. Run \`forge build\` first.`
    );
}

function getAccount(web3) {
    if (!process.env.TESTNET_SEED) {
        throw new Error("TESTNET_SEED environment variable is required");
    }
    return loadDeployer(web3, process.env.TESTNET_SEED);
}

async function deployContract(web3, account, contractName, constructorArgs = []) {
    const artifact = loadArtifact(contractName);
    console.log(`\nDeploying ${contractName}${constructorArgs.length ? `(${constructorArgs.join(", ")})` : ""}...`);

    const contract = new web3.qrl.Contract(artifact.abi);
    const deployTx = contract.deploy({
        data: artifact.bytecode,
        arguments: constructorArgs,
    });

    const gas = await deployTx.estimateGas({ from: account.address });
    console.log(`  gas estimate: ${gas}`);

    const deployed = await deployTx.send({
        from: account.address,
        gas: Math.floor(Number(gas) * 1.2),
    });

    console.log(`  address: ${deployed.options.address}`);
    return deployed;
}

async function sendTx(method, account, label) {
    const gas = await method.estimateGas({ from: account.address });
    const tx = await method.send({
        from: account.address,
        gas: Math.floor(Number(gas) * 1.2),
    });
    console.log(`  ${label}: ${tx.transactionHash || "submitted"}`);
    return tx;
}

// Labelhash helper (keccak256 of UTF-8 label)
function labelhash(label, web3) {
    return web3.utils.keccak256(label);
}

// Namehash helper (EIP-137)
function namehash(name, web3) {
    let node = "0x" + "00".repeat(32);
    if (name) {
        const labels = name.split(".");
        for (let i = labels.length - 1; i >= 0; i--) {
            const labelHash = web3.utils.keccak256(labels[i]);
            node = web3.utils.keccak256(
                "0x" + node.slice(2) + labelHash.slice(2)
            );
        }
    }
    return node;
}

async function main() {
    const config = loadJson(configPath);

    console.log("=".repeat(60));
    console.log("QNS Phase 1 Testnet Deployment");
    console.log("=".repeat(60));
    console.log(`Provider: ${config.rpcUrl}`);
    console.log(`Expected chainId: ${config.chainId}`);
    console.log(`TLD: .${config.tld}`);

    const web3 = new Web3(config.rpcUrl);
    const chainId = await web3.qrl.getChainId();
    console.log(`Connected chainId: ${chainId}`);
    if (Number(chainId) !== config.chainId) {
        throw new Error(
            `chainId mismatch: expected ${config.chainId}, got ${chainId}`
        );
    }

    const account = getAccount(web3);
    console.log(`Deployer: ${account.address}`);
    const balance = await web3.qrl.getBalance(account.address);
    console.log(`Balance: ${web3.utils.fromPlanck(balance, "quanta")} QRL`);

    const tldLabel = labelhash(config.tld, web3);
    const tldNode = namehash(config.tld, web3);
    console.log(`\nTLD labelhash: ${tldLabel}`);
    console.log(`TLD namehash:  ${tldNode}`);

    // ------------------------------------------------------------
    // 1. ENSRegistry — deployer initially owns the root node.
    // ------------------------------------------------------------
    const registry = await deployContract(web3, account, "ENSRegistry");

    // ------------------------------------------------------------
    // 2. Root — takes the registry, then we hand root-node ownership to it.
    // ------------------------------------------------------------
    const root = await deployContract(web3, account, "Root", [
        registry.options.address,
    ]);

    console.log("\nWiring Root as root-node owner...");
    await sendTx(
        registry.methods.setOwner("0x" + "00".repeat(32), root.options.address),
        account,
        "registry.setOwner(ROOT_NODE, root)"
    );

    // Deployer needs controller status on Root to assign the .qrl TLD.
    await sendTx(
        root.methods.setController(account.address, true),
        account,
        "root.setController(deployer, true)"
    );

    // ------------------------------------------------------------
    // 3. FIFSQRLRegistrar(registry, tldNode) — will own the .qrl TLD.
    // ------------------------------------------------------------
    const fifs = await deployContract(web3, account, "FIFSQRLRegistrar", [
        registry.options.address,
        tldNode,
    ]);

    console.log("\nAssigning .qrl TLD to FIFS registrar...");
    await sendTx(
        root.methods.setSubnodeOwner(tldLabel, fifs.options.address),
        account,
        `root.setSubnodeOwner(labelhash("${config.tld}"), fifs)`
    );

    // ------------------------------------------------------------
    // 4. QRLPublicResolver — no wiring needed, any registrant can point at it.
    // ------------------------------------------------------------
    const resolver = await deployContract(web3, account, "QRLPublicResolver", [
        registry.options.address,
    ]);

    // ------------------------------------------------------------
    // Persist addresses.
    // ------------------------------------------------------------
    config.contracts = {
        ENSRegistry: registry.options.address,
        Root: root.options.address,
        FIFSQRLRegistrar: fifs.options.address,
        QRLPublicResolver: resolver.options.address,
    };
    config.deployedAt = new Date().toISOString();
    config.deployer = account.address;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    console.log("\n" + "=".repeat(60));
    console.log("Deployment complete. Addresses written to:");
    console.log(`  ${configPath}`);
    console.log("=".repeat(60));
    for (const [name, addr] of Object.entries(config.contracts)) {
        console.log(`  ${name.padEnd(20)} ${addr}`);
    }
}

main().catch((err) => {
    console.error("\nDeployment failed:", err.message);
    if (err.data) console.error("Data:", err.data);
    process.exit(1);
});
