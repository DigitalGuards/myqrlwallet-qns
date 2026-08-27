// Deploy the QNS Hyperion contract stack to a QRL 2.0 network.
//
// Usage:
//   npm run compile
//   QNS_CONFIG=config/local-qip55.json npm run deploy:testnet
//
// Set TESTNET_SEED, or use QNS_PUBLIC_DEV_ACCOUNT on the local Kurtosis network.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Web3 } = require("@theqrl/web3");
const {
    sha256File,
    validateDeploymentTarget,
    verifyArtifactManifest,
} = require("./lib/hyperionArtifacts");
const { loadDeployerFromEnvironment } = require("./lib/loadDeployer");
const { assertQrl2PQPrecompileTarget } = require("./lib/qrl2Target");

const repoRoot = path.join(__dirname, "..");
const configPath = process.env.QNS_CONFIG
    ? path.resolve(repoRoot, process.env.QNS_CONFIG)
    : path.join(repoRoot, "config", "local-qip55.json");
const hyperionArtifactsDir = path.join(repoRoot, "build", "hyperion");
let verifiedArtifactManifest;

function loadJson(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadHyperionArtifact(contractName) {
    if (
        !verifiedArtifactManifest?.contracts.some(
            (entry) => entry.contractName === contractName
        )
    ) {
        throw new Error(`Verified Hyperion manifest does not contain ${contractName}`);
    }
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

async function deployContract(web3, account, contractName, constructorArgs = []) {
    const artifact = loadHyperionArtifact(contractName);
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
    validateDeploymentTarget(config);
    verifiedArtifactManifest = verifyArtifactManifest({
        hyperionRoot: path.join(repoRoot, "contracts", "hyperion"),
        artifactsDir: hyperionArtifactsDir,
    });

    console.log("=".repeat(60));
    console.log("QNS Testnet Deployment");
    console.log("=".repeat(60));
    console.log(`Provider:        ${config.rpcUrl}`);
    console.log(`Expected chainId: ${config.chainId}`);
    console.log(`TLD:             .${config.tld}`);
    console.log(`Build target:    hyperion (${verifiedArtifactManifest.target.name})`);
    console.log(`Compiler:        ${verifiedArtifactManifest.compiler.version}`);

    const web3 = new Web3(config.rpcUrl);
    const chainId = await web3.qrl.getChainId();
    console.log(`Connected chainId: ${chainId}`);
    if (Number(chainId) !== config.chainId) {
        throw new Error(
            `chainId mismatch: expected ${config.chainId}, got ${chainId}`
        );
    }

    await assertQrl2PQPrecompileTarget(web3);
    console.log("QRL2 target:      slot 3 ML-DSA-87 and slot 6 SHAKE256 passed");

    const account = loadDeployerFromEnvironment(web3, {
        repoRoot,
        rpcUrl: config.rpcUrl,
        chainId,
    });
    console.log(`Deployer: ${account.address}`);
    const balance = await web3.qrl.getBalance(account.address);
    console.log(`Balance: ${web3.utils.fromPlanck(balance, "quanta")} QRL`);

    const tldLabel = labelhash(config.tld, web3);
    const tldNode = namehash(config.tld, web3);
    console.log(`\nTLD labelhash: ${tldLabel}`);
    console.log(`TLD namehash:  ${tldNode}`);

    // ------------------------------------------------------------
    // 1. QNSRegistry: deployer initially owns the root node.
    // ------------------------------------------------------------
    const registry = await deployContract(web3, account, "QNSRegistry");

    // ------------------------------------------------------------
    // 2. Root takes the registry, then we hand root-node ownership to it.
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
    // 3. FIFSQRLRegistrar(registry, tldNode) will own the .qrl TLD.
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
    // 5. QRLPublicResolver(registry, reverseRegistrar) trusts the
    //    reverseRegistrar as an authorised setName() caller.
    // ------------------------------------------------------------
    const resolver = await deployContract(web3, account, "QRLPublicResolver", [
        registry.options.address,
        reverseRegistrar.options.address,
    ]);

    // ------------------------------------------------------------
    // 6. Deploy the QNS adapter for SHAKE256 and ML-DSA-87 verification.
    // ------------------------------------------------------------
    const signatureVerifier = await deployContract(
        web3,
        account,
        "QRLSignatureVerifier"
    );

    // ------------------------------------------------------------
    // 7. Point reverseRegistrar's defaultResolver at QRLPublicResolver.
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
        QNSRegistry: registry.options.address,
        Root: root.options.address,
        FIFSQRLRegistrar: fifs.options.address,
        ReverseRegistrar: reverseRegistrar.options.address,
        QRLPublicResolver: resolver.options.address,
        QRLSignatureVerifier: signatureVerifier.options.address,
    };
    config.deployedAt = new Date().toISOString();
    config.deployer = account.address;
    config.buildTarget = "hyperion";
    config.artifactManifestSha256 = sha256File(
        path.join(hyperionArtifactsDir, "manifest.json")
    );

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
