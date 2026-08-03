// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ENSRegistry} from "@ensdomains/registry/ENSRegistry.sol";
import {Root} from "@ensdomains/root/Root.sol";
import {ReverseRegistrar} from "@ensdomains/reverseRegistrar/ReverseRegistrar.sol";
import {FIFSQRLRegistrar} from "../solidity/registry/FIFSQRLRegistrar.sol";
import {QRLPublicResolver} from "../solidity/resolvers/QRLPublicResolver.sol";
import {INameResolver} from "@ensdomains/resolvers/profiles/INameResolver.sol";

/// @notice Phase 2: reverse resolution end-to-end.
contract ReverseResolutionTest is Test {
    ENSRegistry internal registry;
    Root internal root;
    FIFSQRLRegistrar internal fifs;
    QRLPublicResolver internal resolver;
    ReverseRegistrar internal reverseRegistrar;

    bytes32 internal constant ROOT_NODE = bytes32(0);
    bytes32 internal constant QRL_LABEL = keccak256(bytes("qrl"));
    bytes32 internal constant QRL_NODE =
        keccak256(abi.encodePacked(ROOT_NODE, QRL_LABEL));

    bytes32 internal constant REVERSE_LABEL = keccak256(bytes("reverse"));
    bytes32 internal constant REVERSE_NODE =
        keccak256(abi.encodePacked(ROOT_NODE, REVERSE_LABEL));
    bytes32 internal constant ADDR_LABEL = keccak256(bytes("addr"));
    bytes32 internal constant ADDR_REVERSE_NODE =
        keccak256(abi.encodePacked(REVERSE_NODE, ADDR_LABEL));

    address internal alice = makeAddr("alice");

    function setUp() public {
        registry = new ENSRegistry();

        root = new Root(registry);
        registry.setOwner(ROOT_NODE, address(root));
        root.setController(address(this), true);

        fifs = new FIFSQRLRegistrar(registry, QRL_NODE);
        root.setSubnodeOwner(QRL_LABEL, address(fifs));

        // Wire addr.reverse:
        // 1. Deployer owns `reverse` temporarily so we can assign the `addr` subnode.
        root.setSubnodeOwner(REVERSE_LABEL, address(this));
        // 2. Deploy ReverseRegistrar (only needs `ens`).
        reverseRegistrar = new ReverseRegistrar(registry);
        // 3. Assign addr.reverse -> reverseRegistrar.
        registry.setSubnodeOwner(REVERSE_NODE, ADDR_LABEL, address(reverseRegistrar));

        // 4. Deploy QRLPublicResolver with the reverse registrar trusted as
        //    an authorised setName() caller (so ReverseRegistrar.setNameForAddr
        //    can write to reverse nodes even when the registry owner is the user).
        resolver = new QRLPublicResolver(registry, address(reverseRegistrar));

        // 5. Point reverseRegistrar's defaultResolver at our public resolver.
        reverseRegistrar.setDefaultResolver(address(resolver));
    }

    function test_addrReverseIsOwnedByRegistrar() public view {
        assertEq(registry.owner(ADDR_REVERSE_NODE), address(reverseRegistrar));
    }

    function test_nodeForAddressMatchesExpected() public view {
        bytes32 expected = keccak256(
            abi.encodePacked(ADDR_REVERSE_NODE, _sha3HexAddress(alice))
        );
        assertEq(reverseRegistrar.node(alice), expected);
    }

    function test_setNameAndLookup() public {
        // Register alice.qrl so the forward-confirm side works too.
        bytes32 aliceLabel = keccak256(bytes("alice"));
        vm.prank(alice);
        fifs.register(aliceLabel, alice);

        vm.prank(alice);
        reverseRegistrar.setName("alice.qrl");

        bytes32 reverseNode = reverseRegistrar.node(alice);
        assertEq(resolver.name(reverseNode), "alice.qrl");
    }

    function test_nonOwnerCannotSetAnothersName() public {
        // Bob attempts to set alice's reverse record. Should revert because
        // he's neither the address, a controller, nor approved.
        address bob = makeAddr("bob");
        vm.expectRevert();
        vm.prank(bob);
        reverseRegistrar.setNameForAddr(alice, bob, address(resolver), "evil.qrl");
    }

    function test_trustedReverseRegistrarCannotSetForwardAddress() public {
        bytes32 node = _registerAlice();

        vm.expectRevert();
        vm.prank(address(reverseRegistrar));
        resolver.setAddr(node, alice);
    }

    function test_trustedReverseRegistrarCannotSetForwardQrlAddress() public {
        bytes32 node = _registerAlice();
        bytes memory qrlAddress = hex"000102030405060708090a0b0c0d0e0f1011121314151617";

        vm.expectRevert();
        vm.prank(address(reverseRegistrar));
        resolver.setQrlAddr(node, qrlAddress);
    }

    function test_trustedReverseRegistrarCannotSetForwardText() public {
        bytes32 node = _registerAlice();

        vm.expectRevert();
        vm.prank(address(reverseRegistrar));
        resolver.setText(node, "url", "https://evil.example");
    }

    function test_trustedReverseRegistrarCannotSetForwardContenthash() public {
        bytes32 node = _registerAlice();

        vm.expectRevert();
        vm.prank(address(reverseRegistrar));
        resolver.setContenthash(node, hex"e30101701220");
    }

    function test_trustedReverseRegistrarCannotClearForwardRecords() public {
        bytes32 node = _registerAlice();

        vm.expectRevert();
        vm.prank(address(reverseRegistrar));
        resolver.clearRecords(node);
    }

    function test_nodeOwnerCanSetNameDirectly() public {
        bytes32 node = _registerAlice();

        vm.prank(alice);
        resolver.setName(node, "alice.qrl");

        assertEq(resolver.name(node), "alice.qrl");
    }

    function test_nonOwnerCannotSetNameDirectly() public {
        bytes32 node = _registerAlice();
        address bob = makeAddr("bob");

        vm.expectRevert(
            abi.encodeWithSelector(
                QRLPublicResolver.NotAuthorised.selector,
                node,
                bob
            )
        );
        vm.prank(bob);
        resolver.setName(node, "evil.qrl");
    }

    function test_clearNameByOverwrite() public {
        vm.prank(alice);
        reverseRegistrar.setName("alice.qrl");
        bytes32 reverseNode = reverseRegistrar.node(alice);
        assertEq(resolver.name(reverseNode), "alice.qrl");

        vm.prank(alice);
        reverseRegistrar.setName("");
        assertEq(resolver.name(reverseNode), "");
    }

    function test_supportsINameResolver() public view {
        assertTrue(resolver.supportsInterface(type(INameResolver).interfaceId));
    }

    /// Replicates the optimised ReverseRegistrar.sha3HexAddress assembly in
    /// plain Solidity for test assertions.
    function _sha3HexAddress(address addr) internal pure returns (bytes32) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory buf = new bytes(40);
        uint256 x = uint256(uint160(addr));
        for (uint256 i = 40; i > 0; ) {
            i--;
            buf[i] = hexChars[x & 0xf];
            x >>= 4;
            i--;
            buf[i] = hexChars[x & 0xf];
            x >>= 4;
        }
        return keccak256(buf);
    }

    function _registerAlice() internal returns (bytes32 node) {
        bytes32 label = keccak256(bytes("alice"));
        node = keccak256(abi.encodePacked(QRL_NODE, label));
        vm.prank(alice);
        fifs.register(label, alice);
    }
}
