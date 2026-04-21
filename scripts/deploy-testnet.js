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
const foundryOutDir = path.join(repoRoot, "out");
const hyperionArtifactsDir = path.join(repoRoot, "build", "hyperion");

// "hyperion" (preferred, canonical for mainnet per QRL team recommendation)
// or "foundry" (falls back to solc bytecode). Env override:
//   BUILD=foundry npm run deploy:testnet
const BUILD_TARGET = (process.env.BUILD || "hyperion").toLowerCase();

function loadJson(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadFoundryArtifact(contractName) {
    const artifactPath = path.join(
        foundryOutDir,
        `${contractName}.sol`,
        `${contractName}.json`
    );
    if (!fs.existsSync(artifactPath)) {
        throw new Error(
            `Foundry artifact not found: ${artifactPath}. Run \`forge build\` first.`
        );
    }
    const artifact = loadJson(artifactPath);
    if (!artifact.bytecode || !artifact.bytecode.object) {
        throw new Error(`Foundry artifact ${contractName} has no bytecode.object`);
    }
    return { abi: artifact.abi, bytecode: artifact.bytecode.object };
}

function loadHyperionArtifact(contractName) {
    const abiPath = path.join(hyperionArtifactsDir, `${contractName}.abi`);
    const binPath = path.join(hyperionArtifactsDir, `${contractName}.bin`);
    if (!fs.existsSync(abiPath) || !fs.existsSync(binPath)) {
        throw new Error(
            `Hyperion artifact missing for ${contractName} ` +
                `(expected ${abiPath} + ${binPath}). ` +
                `Run \`node scripts/compile-hyperion.js\` first.`
        );
    }
    const abi = loadJson(abiPath);
    const bytecode = `0x${fs.readFileSync(binPath, "utf8").trim()}`;
    return { abi, bytecode };
}

function loadArtifact(contractName) {
    return BUILD_TARGET === "foundry"
        ? loadFoundryArtifact(contractName)
        : loadHyperionArtifact(contractName);
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

// Subnode = keccak(parent || labelhash(label)).
function subnode(parentNode, label, web3) {
    const l = web3.utils.keccak256(label);
    return web3.utils.keccak256("0x" + parentNode.slice(2) + l.slice(2));
}

async function main() {
    const config = loadJson(configPath);

    console.log("=".repeat(60));
    console.log("QNS Testnet Deployment");
    console.log("=".repeat(60));
    console.log(`Provider:        ${config.rpcUrl}`);
    console.log(`Expected chainId: ${config.chainId}`);
    console.log(`TLD:             .${config.tld}`);
    console.log(`Build target:    ${BUILD_TARGET} (override with BUILD=foundry|hyperion)`);

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
    // 4. Wire addr.reverse namespace.
    //    - Deployer temporarily owns `reverse` so it can create the `addr` subnode.
    //    - Deploy ReverseRegistrar(registry).
    //    - Point reverse.addr node at reverseRegistrar.
    // ------------------------------------------------------------
    console.log("\nWiring addr.reverse namespace...");
    await sendTx(
        root.methods.setSubnodeOwner(
            labelhash("reverse", web3),
            account.address
        ),
        account,
        'root.setSubnodeOwner(labelhash("reverse"), deployer)'
    );

    const reverseRegistrar = await deployContract(
        web3,
        account,
        "ReverseRegistrar",
        [registry.options.address]
    );

    const reverseNode = namehash("reverse", web3);
    await sendTx(
        registry.methods.setSubnodeOwner(
            reverseNode,
            labelhash("addr", web3),
            reverseRegistrar.options.address
        ),
        account,
        'registry.setSubnodeOwner(reverse, labelhash("addr"), reverseRegistrar)'
    );

    // ------------------------------------------------------------
    // 5. QRLPublicResolver(registry, reverseRegistrar) — trusts the
    //    reverseRegistrar as an authorised setName() caller.
    // ------------------------------------------------------------
    const resolver = await deployContract(web3, account, "QRLPublicResolver", [
        registry.options.address,
        reverseRegistrar.options.address,
    ]);

    // ------------------------------------------------------------
    // 6. Point reverseRegistrar's defaultResolver at QRLPublicResolver.
    // ------------------------------------------------------------
    await sendTx(
        reverseRegistrar.methods.setDefaultResolver(resolver.options.address),
        account,
        "reverseRegistrar.setDefaultResolver(resolver)"
    );

    // ------------------------------------------------------------
    // Persist addresses.
    // ------------------------------------------------------------
    if (config.contracts && Object.values(config.contracts).some(Boolean)) {
        config.previousContracts = config.contracts;
    }
    config.contracts = {
        ENSRegistry: registry.options.address,
        Root: root.options.address,
        FIFSQRLRegistrar: fifs.options.address,
        ReverseRegistrar: reverseRegistrar.options.address,
        QRLPublicResolver: resolver.options.address,
    };
    config.deployedAt = new Date().toISOString();
    config.deployer = account.address;
    config.buildTarget = BUILD_TARGET;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    console.log("\n" + "=".repeat(60));
    console.log("Deployment complete. Addresses written to:");
    console.log(`  ${configPath}`);
    console.log("=".repeat(60));
    for (const [name, addr] of Object.entries(config.contracts)) {
        console.log(`  ${name.padEnd(22)} ${addr}`);
    }
}

main().catch((err) => {
    console.error("\nDeployment failed:", err.message);
    if (err.data) console.error("Data:", err.data);
    process.exit(1);
});
