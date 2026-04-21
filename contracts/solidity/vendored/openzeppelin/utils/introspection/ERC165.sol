// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC165.sol";

/// Minimal ERC-165 base for QNS. Matches OpenZeppelin v5 shape.
abstract contract ERC165 is IERC165 {
    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return interfaceId == type(IERC165).interfaceId;
    }
}
