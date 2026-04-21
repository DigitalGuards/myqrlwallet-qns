pragma solidity ^0.8.4;

import "@openzeppelin/contracts/access/Ownable.sol";

// QNS DIFF vs ensdomains/ens-contracts@v1.6.2: added no-arg constructor
// delegating to OZ v5 Ownable(msg.sender). Upstream was written against
// OZ v4 which had a no-arg Ownable. See vendored/DIFFS.md.
contract Controllable is Ownable {
    mapping(address => bool) public controllers;

    event ControllerChanged(address indexed controller, bool enabled);

    modifier onlyController() {
        require(
            controllers[msg.sender],
            "Controllable: Caller is not a controller"
        );
        _;
    }

    constructor() Ownable(msg.sender) {}

    function setController(address controller, bool enabled) public onlyOwner {
        controllers[controller] = enabled;
        emit ControllerChanged(controller, enabled);
    }
}
