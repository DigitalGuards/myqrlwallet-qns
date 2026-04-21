// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import {ENS} from "@ensdomains/registry/ENS.sol";
import {ResolverBase} from "@ensdomains/resolvers/ResolverBase.sol";
import {IAddrResolver} from "@ensdomains/resolvers/profiles/IAddrResolver.sol";
import {ITextResolver} from "@ensdomains/resolvers/profiles/ITextResolver.sol";
import {IContentHashResolver} from "@ensdomains/resolvers/profiles/IContentHashResolver.sol";
import {IQRLAddrResolver} from "./profiles/IQRLAddrResolver.sol";

/// @title QRLPublicResolver
/// @notice Minimal public resolver for QNS Phase 1.2. Supports legacy
///         `IAddrResolver` (20-byte EVM address), `IQRLAddrResolver` (24-byte
///         QRL wallet-display form), `ITextResolver`, and `IContentHashResolver`.
///
/// Authorisation: only the current owner of a node in the ENS registry can
/// write records. The underlying `ResolverBase` provides ERC165 + versioned
/// records (clearRecords bumps a per-node version counter).
///
/// Deliberately omitted for alpha:
///   - `IAddressResolver` (EIP-2304 multichain addr) — Phase 3.
///   - `INameResolver` (reverse) — Phase 2, lives on ReverseRegistrar.
///   - `IPubkeyResolver` — Phase 4, extended with ML-DSA pubkey storage.
///   - `IInterfaceResolver` / `IABIResolver` — optional, revisit Phase 3.
///   - NameWrapper / DNS / ENSIP-10 — out of scope.
contract QRLPublicResolver is
    ResolverBase,
    IAddrResolver,
    IQRLAddrResolver,
    ITextResolver,
    IContentHashResolver
{
    ENS public immutable ens;

    mapping(uint64 => mapping(bytes32 => address)) private _addr;
    mapping(uint64 => mapping(bytes32 => bytes)) private _qrlAddr;
    mapping(uint64 => mapping(bytes32 => mapping(string => string))) private _texts;
    mapping(uint64 => mapping(bytes32 => bytes)) private _contenthashes;

    error NotAuthorised(bytes32 node, address caller);
    error InvalidQRLAddressLength(uint256 actualLength);

    constructor(ENS _ens) {
        ens = _ens;
    }

    /// @inheritdoc ResolverBase
    function isAuthorised(bytes32 node) internal view override returns (bool) {
        return ens.owner(node) == msg.sender;
    }

    // -----------------------------------------------------------------
    // IAddrResolver: 20-byte EVM address (legacy, for tooling compat)
    // -----------------------------------------------------------------

    function addr(bytes32 node) external view override returns (address payable) {
        return payable(_addr[recordVersions[node]][node]);
    }

    function setAddr(bytes32 node, address a) external authorised(node) {
        _addr[recordVersions[node]][node] = a;
        emit AddrChanged(node, a);
    }

    // -----------------------------------------------------------------
    // IQRLAddrResolver: 24-byte QRL wallet-display address (primary)
    // -----------------------------------------------------------------

    function qrlAddr(bytes32 node) external view override returns (bytes memory) {
        return _qrlAddr[recordVersions[node]][node];
    }

    function setQrlAddr(bytes32 node, bytes calldata qrlAddress) external authorised(node) {
        // Accept empty (clear) or exactly 24 bytes (set). Anything else is
        // a bug at the caller.
        if (qrlAddress.length != 0 && qrlAddress.length != 24) {
            revert InvalidQRLAddressLength(qrlAddress.length);
        }
        _qrlAddr[recordVersions[node]][node] = qrlAddress;
        emit QrlAddrChanged(node, qrlAddress);
    }

    // -----------------------------------------------------------------
    // ITextResolver
    // -----------------------------------------------------------------

    function text(
        bytes32 node,
        string calldata key
    ) external view override returns (string memory) {
        return _texts[recordVersions[node]][node][key];
    }

    function setText(
        bytes32 node,
        string calldata key,
        string calldata value
    ) external authorised(node) {
        _texts[recordVersions[node]][node][key] = value;
        emit TextChanged(node, key, key, value);
    }

    // -----------------------------------------------------------------
    // IContentHashResolver
    // -----------------------------------------------------------------

    function contenthash(bytes32 node) external view override returns (bytes memory) {
        return _contenthashes[recordVersions[node]][node];
    }

    function setContenthash(bytes32 node, bytes calldata hash) external authorised(node) {
        _contenthashes[recordVersions[node]][node] = hash;
        emit ContenthashChanged(node, hash);
    }

    // -----------------------------------------------------------------
    // ERC165
    // -----------------------------------------------------------------

    function supportsInterface(
        bytes4 interfaceID
    ) public view override(ResolverBase) returns (bool) {
        return
            interfaceID == type(IAddrResolver).interfaceId ||
            interfaceID == type(IQRLAddrResolver).interfaceId ||
            interfaceID == type(ITextResolver).interfaceId ||
            interfaceID == type(IContentHashResolver).interfaceId ||
            super.supportsInterface(interfaceID);
    }
}
