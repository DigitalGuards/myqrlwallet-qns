// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ENSRegistry} from "@ensdomains/registry/ENSRegistry.sol";
import {Root} from "@ensdomains/root/Root.sol";
import {FIFSQRLRegistrar} from "../solidity/registry/FIFSQRLRegistrar.sol";
import {QRLPublicResolver} from "../solidity/resolvers/QRLPublicResolver.sol";
import {IQRLAddrResolver} from "../solidity/resolvers/profiles/IQRLAddrResolver.sol";
import {IAddrResolver} from "@ensdomains/resolvers/profiles/IAddrResolver.sol";
import {ITextResolver} from "@ensdomains/resolvers/profiles/ITextResolver.sol";
import {IContentHashResolver} from "@ensdomains/resolvers/profiles/IContentHashResolver.sol";

/// @title ForwardResolutionTest
/// @notice End-to-end integration test for Phase 1.2.
///         Deploys the full registry + root + FIFS `.qrl` + resolver stack,
///         registers names, sets records, and reads them back.
contract ForwardResolutionTest is Test {
    ENSRegistry internal registry;
    Root internal root;
    FIFSQRLRegistrar internal fifs;
    QRLPublicResolver internal resolver;

    bytes32 internal constant ROOT_NODE = bytes32(0);
    bytes32 internal constant QRL_LABEL = keccak256(bytes("qrl"));
    bytes32 internal constant QRL_NODE =
        keccak256(abi.encodePacked(ROOT_NODE, QRL_LABEL));

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        // 1. ENSRegistry: deployer (this) gets root node ownership.
        registry = new ENSRegistry();

        // 2. Root contract: owns root node, gates TLD assignment via controllers.
        root = new Root(registry);
        registry.setOwner(ROOT_NODE, address(root));

        // 3. FIFS registrar for `.qrl` under Root.
        fifs = new FIFSQRLRegistrar(registry, QRL_NODE);
        root.setController(address(this), true);
        root.setSubnodeOwner(QRL_LABEL, address(fifs));

        // 4. Resolver that owners will point nodes at.
        // Forward-only tests: no reverse registrar trust needed.
        resolver = new QRLPublicResolver(registry, address(0));
    }

    // -----------------------------------------------------------------
    // Deploy + wiring sanity
    // -----------------------------------------------------------------

    function test_rootOwnsRootNode() public view {
        assertEq(registry.owner(ROOT_NODE), address(root));
    }

    function test_fifsOwnsQrlTld() public view {
        assertEq(registry.owner(QRL_NODE), address(fifs));
    }

    function test_aliceQrlIsInitiallyUnowned() public view {
        bytes32 aliceNode = _subnode(QRL_NODE, keccak256(bytes("alice")));
        assertEq(registry.owner(aliceNode), address(0));
        assertTrue(fifs.available(keccak256(bytes("alice"))));
    }

    // -----------------------------------------------------------------
    // FIFS registration
    // -----------------------------------------------------------------

    function test_registerAliceQrl() public {
        bytes32 aliceLabel = keccak256(bytes("alice"));
        bytes32 aliceNode = _subnode(QRL_NODE, aliceLabel);

        vm.prank(alice);
        fifs.register(aliceLabel, alice);

        assertEq(registry.owner(aliceNode), alice);
        assertFalse(fifs.available(aliceLabel));
    }

    function test_cannotRegisterAlreadyOwnedLabel() public {
        bytes32 aliceLabel = keccak256(bytes("alice"));

        vm.prank(alice);
        fifs.register(aliceLabel, alice);

        // Bob tries to steal alice.qrl — should revert.
        vm.expectRevert(
            abi.encodeWithSelector(
                FIFSQRLRegistrar.NotAvailable.selector,
                aliceLabel,
                alice
            )
        );
        vm.prank(bob);
        fifs.register(aliceLabel, bob);
    }

    function test_ownerCanTransferViaRegistrar() public {
        bytes32 aliceLabel = keccak256(bytes("alice"));
        bytes32 aliceNode = _subnode(QRL_NODE, aliceLabel);

        vm.prank(alice);
        fifs.register(aliceLabel, alice);

        vm.prank(alice);
        fifs.register(aliceLabel, bob);

        assertEq(registry.owner(aliceNode), bob);
    }

    // -----------------------------------------------------------------
    // Forward resolution: set + get records
    // -----------------------------------------------------------------

    function test_setAndGetQrlAddr() public {
        bytes32 aliceNode = _registerAs(alice, "alice");

        // Point resolver.
        vm.prank(alice);
        registry.setResolver(aliceNode, address(resolver));

        // 24-byte sentinel QRL address.
        bytes memory qrlAddress = hex"000102030405060708090a0b0c0d0e0f1011121314151617";
        assertEq(qrlAddress.length, 24);

        vm.expectEmit(true, false, false, true);
        emit IQRLAddrResolver.QrlAddrChanged(aliceNode, qrlAddress);

        vm.prank(alice);
        resolver.setQrlAddr(aliceNode, qrlAddress);

        bytes memory readBack = resolver.qrlAddr(aliceNode);
        assertEq(readBack, qrlAddress);
    }

    function test_setQrlAddrRejectsWrongLength() public {
        bytes32 aliceNode = _registerAs(alice, "alice");
        vm.prank(alice);
        registry.setResolver(aliceNode, address(resolver));

        bytes memory wrongLen = hex"0102030405";

        vm.expectRevert(
            abi.encodeWithSelector(
                QRLPublicResolver.InvalidQRLAddressLength.selector,
                uint256(5)
            )
        );
        vm.prank(alice);
        resolver.setQrlAddr(aliceNode, wrongLen);
    }

    function test_setQrlAddrAcceptsClear() public {
        bytes32 aliceNode = _registerAs(alice, "alice");
        vm.prank(alice);
        registry.setResolver(aliceNode, address(resolver));

        // Set then clear.
        bytes memory qrlAddress = hex"000102030405060708090a0b0c0d0e0f1011121314151617";
        vm.prank(alice);
        resolver.setQrlAddr(aliceNode, qrlAddress);

        vm.prank(alice);
        resolver.setQrlAddr(aliceNode, "");

        assertEq(resolver.qrlAddr(aliceNode).length, 0);
    }

    function test_setQrlAddrRejectsNonOwner() public {
        bytes32 aliceNode = _registerAs(alice, "alice");
        vm.prank(alice);
        registry.setResolver(aliceNode, address(resolver));

        bytes memory qrlAddress = hex"000102030405060708090a0b0c0d0e0f1011121314151617";

        // Bob (non-owner) cannot set alice's record.
        vm.expectRevert();
        vm.prank(bob);
        resolver.setQrlAddr(aliceNode, qrlAddress);
    }

    function test_setAndGetLegacyAddr() public {
        bytes32 aliceNode = _registerAs(alice, "alice");
        vm.prank(alice);
        registry.setResolver(aliceNode, address(resolver));

        vm.expectEmit(true, false, false, true);
        emit IAddrResolver.AddrChanged(aliceNode, alice);

        vm.prank(alice);
        resolver.setAddr(aliceNode, alice);

        assertEq(resolver.addr(aliceNode), payable(alice));
    }

    function test_setAndGetText() public {
        bytes32 aliceNode = _registerAs(alice, "alice");
        vm.prank(alice);
        registry.setResolver(aliceNode, address(resolver));

        vm.prank(alice);
        resolver.setText(aliceNode, "url", "https://qrl.example");

        assertEq(resolver.text(aliceNode, "url"), "https://qrl.example");
    }

    function test_setAndGetContenthash() public {
        bytes32 aliceNode = _registerAs(alice, "alice");
        vm.prank(alice);
        registry.setResolver(aliceNode, address(resolver));

        // IPFS contenthash prefix (0xe3=ipfs-ns, 0x0101=cidv1, 0x70=dag-pb, 0x1220=sha256+32B)
        // followed by a 32-byte sentinel digest.
        bytes memory ch = hex"e30101701220";
        bytes32 digest = keccak256("sentinel");
        ch = bytes.concat(ch, abi.encodePacked(digest));

        vm.prank(alice);
        resolver.setContenthash(aliceNode, ch);

        assertEq(resolver.contenthash(aliceNode), ch);
    }

    function test_clearRecordsBumpsVersion() public {
        bytes32 aliceNode = _registerAs(alice, "alice");
        vm.prank(alice);
        registry.setResolver(aliceNode, address(resolver));

        bytes memory qrlAddress = hex"000102030405060708090a0b0c0d0e0f1011121314151617";
        vm.prank(alice);
        resolver.setQrlAddr(aliceNode, qrlAddress);

        uint64 v0 = resolver.recordVersions(aliceNode);

        vm.prank(alice);
        resolver.clearRecords(aliceNode);

        uint64 v1 = resolver.recordVersions(aliceNode);
        assertEq(v1, v0 + 1);

        // Old records not visible after clear.
        assertEq(resolver.qrlAddr(aliceNode).length, 0);
    }

    function test_supportsInterface() public view {
        // ERC165
        assertTrue(resolver.supportsInterface(0x01ffc9a7));
        // Our profiles
        assertTrue(resolver.supportsInterface(type(IAddrResolver).interfaceId));
        assertTrue(resolver.supportsInterface(type(IQRLAddrResolver).interfaceId));
        assertTrue(resolver.supportsInterface(type(ITextResolver).interfaceId));
        assertTrue(resolver.supportsInterface(type(IContentHashResolver).interfaceId));
        // Random interface id — should be false.
        assertFalse(resolver.supportsInterface(0xdeadbeef));
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    function _subnode(bytes32 parent, bytes32 label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, label));
    }

    function _registerAs(address who, string memory label) internal returns (bytes32 node) {
        bytes32 labelHash = keccak256(bytes(label));
        node = _subnode(QRL_NODE, labelHash);
        vm.prank(who);
        fifs.register(labelHash, who);
    }
}
