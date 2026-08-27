// Live contract behavior suite for the deployed QNS stack.
//
// Restores the authorization coverage lost with the Solidity test suite in
// Hyperion-native form, as observational tests against a deployed stack on
// the local Kurtosis network. The vm.prank-style impersonation cases from the
// old Foundry suite (sending as the trusted reverse registrar itself) cannot
// be expressed against a live chain; their policy core is proved in
// test/formal/QNSSecurityProperties.hyp and observed here from the outside.
//
// Usage:
//   npm run compile && QNS_CONFIG=config/local-qip55.json npm run deploy:testnet
//   QNS_BEHAVIOR=1 QNS_PUBLIC_DEV_ACCOUNT=0 npm run test:behavior
//
// Requires two funded public development accounts on the local network
// (QNS_PUBLIC_DEV_ACCOUNT for the primary, QNS_BEHAVIOR_SECOND_ACCOUNT for
// the adversary, default 1). The suite registers fresh run-scoped labels and
// never touches existing names.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..", "..");

if (process.env.QNS_BEHAVIOR !== "1") {
    test("contract behavior suite", {
        skip: "set QNS_BEHAVIOR=1 with a deployed local stack to run",
    }, () => {});
} else {
    const { Web3 } = require("@theqrl/web3");
    const {
        loadDeployer,
        loadDeployerFromEnvironment,
        loadPublicDevSeed,
    } = require("../../scripts/lib/loadDeployer");

    const configPath = process.env.QNS_CONFIG
        ? path.resolve(repoRoot, process.env.QNS_CONFIG)
        : path.join(repoRoot, "config", "local-qip55.json");
    const artifactsDir = path.join(repoRoot, "build", "hyperion");
    const vectors = JSON.parse(
        fs.readFileSync(
            path.join(repoRoot, "sdk", "src", "fixtures", "qns-vectors.json"),
            "utf8"
        )
    );

    const loadJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

    test("contract behavior suite", { timeout: 600000 }, async (t) => {
        const config = loadJson(configPath);
        const web3 = new Web3(config.rpcUrl);
        const chainId = Number(await web3.qrl.getChainId());
        assert.equal(chainId, config.chainId, "config chainId matches the node");

        const alice = loadDeployerFromEnvironment(web3, {
            repoRoot,
            rpcUrl: config.rpcUrl,
            chainId,
            env: process.env,
        });
        const secondIndex = process.env.QNS_BEHAVIOR_SECOND_ACCOUNT || "1";
        const bob = loadDeployer(
            web3,
            loadPublicDevSeed(repoRoot, secondIndex, process.env)
        );
        assert.notEqual(
            alice.address.toLowerCase(),
            bob.address.toLowerCase(),
            "primary and adversary accounts differ"
        );

        const at = (name) =>
            new web3.qrl.Contract(
                loadJson(path.join(artifactsDir, `${name}.abi`)),
                config.contracts[name]
            );
        const registry = at("QNSRegistry");
        const root = at("Root");
        const registrar = at("FIFSQRLRegistrar");
        const reverseRegistrar = at("ReverseRegistrar");
        const resolver = at("QRLPublicResolver");

        const send = async (contract, methodCall, from) => {
            const gas = await methodCall.estimateGas({ from });
            return web3.qrl.sendTransaction({
                from,
                to: contract.options.address,
                data: methodCall.encodeABI(),
                gas: Math.floor(Number(gas) * 1.2),
            });
        };
        // Reverts surface as estimateGas rejections, so no gas is spent.
        const expectRevert = (methodCall, from, label) =>
            assert.rejects(methodCall.estimateGas({ from }), undefined, label);

        const tld = config.tld || "qrl";
        const runPrefix = `bt${Date.now().toString(36)}`;
        const labelhash = (label) => web3.utils.keccak256(label);
        const namehash = (name) => {
            let node = "0x" + "00".repeat(32);
            if (!name) return node;
            for (const label of name.split(".").reverse()) {
                node = web3.utils.keccak256(
                    "0x" + node.slice(2) + web3.utils.keccak256(label).slice(2)
                );
            }
            return node;
        };
        const tldNode = namehash(tld);
        const zeroAddress = `Q${"0".repeat(128)}`;
        const sameAddr = (a, b) =>
            a.replace(/^0x|^Q/i, "").toLowerCase() ===
            b.replace(/^0x|^Q/i, "").toLowerCase();

        await t.test("QNS rename: registry getters preserve the ENS compatibility alias", async () => {
            for (const [name, contract] of [
                ["Root", root],
                ["FIFSQRLRegistrar", registrar],
                ["ReverseRegistrar", reverseRegistrar],
                ["QRLPublicResolver", resolver],
            ]) {
                const qns = await contract.methods.qns().call();
                const ens = await contract.methods.ens().call();
                assert.ok(sameAddr(qns, config.contracts.QNSRegistry), `${name}.qns()`);
                assert.ok(sameAddr(ens, config.contracts.QNSRegistry), `${name}.ens()`);
            }
        });

        await t.test("registrar: fresh label registers to the caller", async () => {
            const label = `${runPrefix}-fresh`;
            assert.equal(await registrar.methods.available(labelhash(label)).call(), true);
            await send(
                registrar,
                registrar.methods.register(labelhash(label), alice.address),
                alice.address
            );
            assert.equal(await registrar.methods.available(labelhash(label)).call(), false);
            const node = namehash(`${label}.${tld}`);
            assert.ok(sameAddr(await registry.methods.owner(node).call(), alice.address));
        });

        await t.test("registrar: an owned label is not registrable by another account", async () => {
            const label = `${runPrefix}-taken`;
            await send(
                registrar,
                registrar.methods.register(labelhash(label), alice.address),
                alice.address
            );
            await expectRevert(
                registrar.methods.register(labelhash(label), bob.address),
                bob.address,
                "second registration must revert"
            );
        });

        await t.test("registrar: the current owner can reassign the label", async () => {
            const label = `${runPrefix}-move`;
            await send(
                registrar,
                registrar.methods.register(labelhash(label), alice.address),
                alice.address
            );
            await send(
                registrar,
                registrar.methods.register(labelhash(label), bob.address),
                alice.address
            );
            const node = namehash(`${label}.${tld}`);
            assert.ok(sameAddr(await registry.methods.owner(node).call(), bob.address));
        });

        await t.test("registry: a stranger cannot take subnodes under another owner's name", async () => {
            const label = `${runPrefix}-sub`;
            await send(
                registrar,
                registrar.methods.register(labelhash(label), alice.address),
                alice.address
            );
            const node = namehash(`${label}.${tld}`);
            await expectRevert(
                registry.methods.setSubnodeOwner(node, labelhash("stolen"), bob.address),
                bob.address,
                "unauthorized setSubnodeOwner must revert"
            );
            await expectRevert(
                registry.methods.setResolver(node, config.contracts.QRLPublicResolver),
                bob.address,
                "unauthorized setResolver must revert"
            );
        });

        await t.test("resolver: only the name owner writes records", async () => {
            const label = `${runPrefix}-rec`;
            const name = `${label}.${tld}`;
            await send(
                registrar,
                registrar.methods.register(labelhash(label), alice.address),
                alice.address
            );
            const node = namehash(name);
            await send(
                registry,
                registry.methods.setResolver(node, config.contracts.QRLPublicResolver),
                alice.address
            );
            await send(resolver, resolver.methods.setAddr(node, alice.address), alice.address);
            assert.ok(sameAddr(await resolver.methods.addr(node).call(), alice.address));
            await send(
                resolver,
                resolver.methods.setText(node, "url", "https://example.org"),
                alice.address
            );
            assert.equal(await resolver.methods.text(node, "url").call(), "https://example.org");

            await expectRevert(
                resolver.methods.setAddr(node, bob.address),
                bob.address,
                "non-owner setAddr must revert"
            );
            await expectRevert(
                resolver.methods.setText(node, "url", "https://attacker.example"),
                bob.address,
                "non-owner setText must revert"
            );
            await expectRevert(
                resolver.methods.setContenthash(node, "0x1234"),
                bob.address,
                "non-owner setContenthash must revert"
            );
            await expectRevert(
                resolver.methods.clearRecords(node),
                bob.address,
                "non-owner clearRecords must revert"
            );
            await expectRevert(
                resolver.methods.setName(node, "attacker"),
                bob.address,
                "non-owner setName on a forward node must revert"
            );
        });

        await t.test("reverse registrar: node derivation matches the shared fixture", async () => {
            const chainNode = await reverseRegistrar.methods
                .node(vectors.reverse.address)
                .call();
            assert.equal(chainNode.toLowerCase(), vectors.reverse.node);
            const sdk = await import("../../sdk/dist/index.js");
            assert.equal(
                sdk.reverseNodeFor(vectors.reverse.address),
                vectors.reverse.node
            );
        });

        await t.test("reverse registrar: claims are authorized and scoped", async () => {
            await expectRevert(
                reverseRegistrar.methods.claimForAddr(
                    alice.address,
                    bob.address,
                    config.contracts.QRLPublicResolver
                ),
                bob.address,
                "claiming another account's reverse record must revert"
            );

            const forwardLabel = `${runPrefix}-rev`;
            const forwardName = `${forwardLabel}.${tld}`;
            await send(
                registrar,
                registrar.methods.register(labelhash(forwardLabel), alice.address),
                alice.address
            );
            const forwardNode = namehash(forwardName);
            await send(
                registry,
                registry.methods.setResolver(forwardNode, config.contracts.QRLPublicResolver),
                alice.address
            );
            await send(
                resolver,
                resolver.methods.setAddr(forwardNode, alice.address),
                alice.address
            );

            await send(
                reverseRegistrar,
                reverseRegistrar.methods.setName(forwardName),
                alice.address
            );
            const reverseNode = await reverseRegistrar.methods.node(alice.address).call();
            assert.ok(
                sameAddr(await registry.methods.owner(reverseNode).call(), alice.address),
                "claiming account owns its reverse node"
            );
            const storedName = await resolver.methods.name(reverseNode).call();
            assert.equal(storedName, forwardName);

            // The trusted-registrar path must not have touched the forward
            // records (the live face of the PR #2 regression set).
            assert.ok(sameAddr(await resolver.methods.addr(forwardNode).call(), alice.address));
            assert.equal(await resolver.methods.name(forwardNode).call(), "");
            assert.notEqual(
                await registry.methods.owner(forwardNode).call(),
                zeroAddress,
                "forward node ownership survives the reverse claim"
            );
        });
    });
}
