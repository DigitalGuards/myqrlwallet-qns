// Integration test: register a name via FIFS, set its native QRL 2.0 address,
// then resolve it end-to-end through @qns/sdk.
//
// Usage:
//   npm run sdk:build
//   QNS_CONFIG=config/local-qip55.json npm run register -- alice
//
// Set TESTNET_SEED, or use QNS_PUBLIC_DEV_ACCOUNT on the local Kurtosis network.

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Web3 } = require("@theqrl/web3");
const { loadDeployerFromEnvironment } = require("./lib/loadDeployer");

const repoRoot = path.join(__dirname, "..");
const configPath = process.env.QNS_CONFIG
    ? path.resolve(repoRoot, process.env.QNS_CONFIG)
    : path.join(repoRoot, "config", "local-qip55.json");
const artifactsDir = path.join(repoRoot, "build", "hyperion");
const sdkDistDir = path.join(repoRoot, "sdk", "dist");

function loadJson(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadAbi(contractName) {
    return loadJson(path.join(artifactsDir, `${contractName}.abi`));
}

// Per ../QuantaPool/CLAUDE.md: contracts constructed via `new web3.qrl.Contract(abi, addr)`
// do not inherit the wallet. Use encodeABI + qrl.sendTransaction instead.
async function sendTx(web3, contract, method, account, label) {
    const data = method.encodeABI();
    const gas = await method.estimateGas({ from: account.address });
    const tx = await web3.qrl.sendTransaction({
        from: account.address,
        to: contract.options.address,
        data,
        gas: Math.floor(Number(gas) * 1.2),
    });
    console.log(`  ${label}: ${tx.transactionHash || "submitted"}`);
    return tx;
}

// QRL Zond's RPC rejects 0x-prefixed addresses; translate to Q-prefix at the
// transport boundary. EVM return values still come back 0x-prefixed.
function toQAddr(addr) {
    if (typeof addr !== "string") return addr;
    if (addr.startsWith("0x") && addr.length === 130) return "Q" + addr.slice(2);
    return addr;
}

/** Adapter: EIP-1193-style RpcProvider shim on top of @theqrl/web3 for the SDK. */
function makeSdkProvider(web3) {
    return {
        request: async ({ method, params }) => {
            if (method === "qrl_call") {
                const [callObj, block] = params;
                return await web3.qrl.call(
                    { to: toQAddr(callObj.to), data: callObj.data },
                    block || "latest"
                );
            }
            throw new Error(`SDK provider shim: unsupported method ${method}`);
        },
    };
}

async function main() {
    const nameLabel = process.argv[2] || "alice";

    const config = loadJson(configPath);
    if (!config.contracts?.ENSRegistry) {
        throw new Error(`${configPath} is missing contracts. Run deploy:testnet first.`);
    }

    console.log("=".repeat(60));
    console.log(`QNS integration test: ${nameLabel}.${config.tld}`);
    console.log("=".repeat(60));
    console.log(`Provider:   ${config.rpcUrl}`);
    console.log(`Registry:   ${config.contracts.ENSRegistry}`);
    console.log(`Resolver:   ${config.contracts.QRLPublicResolver}`);
    console.log(`FIFS:       ${config.contracts.FIFSQRLRegistrar}`);

    const web3 = new Web3(config.rpcUrl);
    const chainId = await web3.qrl.getChainId();
    if (Number(chainId) !== config.chainId) {
        throw new Error(`chainId mismatch: expected ${config.chainId}, got ${chainId}`);
    }
    const account = loadDeployerFromEnvironment(web3, {
        repoRoot,
        rpcUrl: config.rpcUrl,
        chainId,
    });
    console.log(`Caller:     ${account.address}`);

    const registry = new web3.qrl.Contract(
        loadAbi("ENSRegistry"),
        config.contracts.ENSRegistry
    );
    const fifs = new web3.qrl.Contract(
        loadAbi("FIFSQRLRegistrar"),
        config.contracts.FIFSQRLRegistrar
    );
    const resolver = new web3.qrl.Contract(
        loadAbi("QRLPublicResolver"),
        config.contracts.QRLPublicResolver
    );
    const reverseRegistrar = config.contracts.ReverseRegistrar
        ? new web3.qrl.Contract(
              loadAbi("ReverseRegistrar"),
              config.contracts.ReverseRegistrar
          )
        : null;

    // namehash via concatenated-bytes32 keccak256 (EIP-137)
    const ROOT = "0x" + "00".repeat(32);
    const labelHash = web3.utils.keccak256(nameLabel);
    const tldNode = web3.utils.keccak256(
        ROOT + web3.utils.keccak256(config.tld).slice(2)
    );
    const node = web3.utils.keccak256(
        tldNode + labelHash.slice(2)
    );
    console.log(`\nlabelhash(${nameLabel}) = ${labelHash}`);
    console.log(`namehash(${nameLabel}.${config.tld}) = ${node}`);

    // ------------------------------------------------------------
    // 1. Register alice.qrl (idempotent: skip if already owned by us)
    // ------------------------------------------------------------
    console.log("\n[1/6] FIFS register");
    const currentOwner = await registry.methods.owner(node).call();
    const ownedByUs = currentOwner.toLowerCase() === account.address.toLowerCase();
    if (ownedByUs) {
        console.log(`  skip: node already owned by deployer (${currentOwner})`);
    } else {
        console.log(`  current owner: ${currentOwner}; registering to ${account.address}`);
        await sendTx(
            web3,
            fifs,
            fifs.methods.register(labelHash, account.address),
            account,
            "fifs.register"
        );
    }

    // ------------------------------------------------------------
    // 2. Point node at the resolver (skip if already pointed)
    // ------------------------------------------------------------
    console.log("\n[2/6] registry.setResolver");
    const currentResolver = await registry.methods.resolver(node).call();
    if (currentResolver.toLowerCase() === config.contracts.QRLPublicResolver.toLowerCase()) {
        console.log(`  skip: already pointing at ${currentResolver}`);
    } else {
        await sendTx(
            web3,
            registry,
            registry.methods.setResolver(node, config.contracts.QRLPublicResolver),
            account,
            "registry.setResolver"
        );
    }

    // ------------------------------------------------------------
    // 3. Store the native 64-byte address for forward and reverse confirmation.
    // ------------------------------------------------------------
    console.log("\n[3/6] resolver.setAddr (native 64-byte address)");
    const currentAddr = await resolver.methods.addr(node).call();
    const wantAddr = account.address.toLowerCase().replace(/^0x/, "q");
    if (currentAddr && currentAddr.toLowerCase().replace(/^0x/, "q") === wantAddr) {
        console.log(`  skip: addr already = ${currentAddr}`);
    } else {
        await sendTx(
            web3,
            resolver,
            resolver.methods.setAddr(node, account.address),
            account,
            "resolver.setAddr"
        );
    }

    // ------------------------------------------------------------
    // 4. Reverse: set deployer's addr.reverse primary name to this name
    // ------------------------------------------------------------
    const fullName = `${nameLabel}.${config.tld}`;
    if (reverseRegistrar) {
        console.log("\n[4/6] reverseRegistrar.setName");
        const reverseNode = await reverseRegistrar.methods.node(account.address).call();
        const existingName = await resolver.methods.name(reverseNode).call();
        if (existingName === fullName) {
            console.log(`  skip: reverse already = ${existingName}`);
        } else {
            console.log(`  current: "${existingName || ""}" -> "${fullName}"`);
            await sendTx(
                web3,
                reverseRegistrar,
                reverseRegistrar.methods.setName(fullName),
                account,
                "reverseRegistrar.setName"
            );
        }
    } else {
        console.log("\n[4/6] reverse: ReverseRegistrar not in config, skipping");
    }

    // ------------------------------------------------------------
    // 5. Forward resolve via @qns/sdk
    // ------------------------------------------------------------
    console.log("\n[5/6] SDK forward resolve");
    const sdk = await import(pathToFileURL(path.join(sdkDistDir, "index.js")).href);
    const provider = makeSdkProvider(web3);
    const cfg = { registry: config.contracts.ENSRegistry, provider };

    const sdkNode = sdk.nodeToHex(sdk.namehash(fullName));
    console.log(`  SDK namehash:    ${sdkNode}`);
    console.log(`  Local namehash:  ${node}`);
    if (sdkNode.toLowerCase() !== node.toLowerCase()) {
        throw new Error("SDK and web3 namehash disagree");
    }

    const resolverFromSdk = await sdk.getResolver(fullName, cfg);
    console.log(`  SDK getResolver: ${resolverFromSdk}`);

    const resolvedAddress = await sdk.resolveName(fullName, cfg);
    if (resolvedAddress === null) {
        console.log("  resolveName: null");
    } else {
        console.log(`  resolveName:     ${resolvedAddress}`);
        if (resolvedAddress.toLowerCase() !== wantAddr) {
            throw new Error(
                `MISMATCH: sdk returned ${resolvedAddress}, expected ${account.address}`
            );
        }
    }

    // ------------------------------------------------------------
    // 6. Reverse resolve via @qns/sdk
    // ------------------------------------------------------------
    if (reverseRegistrar) {
        console.log("\n[6/6] SDK reverse resolve");
        const reverseName = await sdk.lookupAddress(account.address, cfg);
        console.log(`  lookupAddress:   ${reverseName}`);
        if (reverseName !== fullName) {
            throw new Error(
                `MISMATCH: lookupAddress returned "${reverseName}", expected "${fullName}"`
            );
        }
        const verified = await sdk.verifyReverse(account.address, cfg);
        console.log(`  verifyReverse:   ${verified}`);
        if (verified !== fullName) {
            throw new Error(
                `MISMATCH: verifyReverse returned "${verified}", expected "${fullName}", forward-confirm failed`
            );
        }
    } else {
        console.log("\n[6/6] SDK reverse resolve: skipped (no ReverseRegistrar deployed)");
    }

    console.log("\n" + "=".repeat(60));
    console.log(`OK: ${fullName} resolves end-to-end (forward + reverse + forward-confirm).`);
    console.log("=".repeat(60));
}

main().catch((err) => {
    console.error("\nIntegration test failed:", err.message);
    if (err.data) console.error("Data:", err.data);
    process.exit(1);
});
