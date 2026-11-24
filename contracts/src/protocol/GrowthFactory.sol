// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {GrowthWorkspace} from "./GrowthWorkspace.sol";

/// @notice Creates an isolated workspace contract for each customer. It has no owner and cannot touch their funds.
contract GrowthFactory {
    address public immutable implementation;
    address public immutable usdc;
    address public immutable usdt;
    address public immutable reactor;
    mapping(address => bool) public isWorkspace;
    mapping(address => bool) public isPayoutToken;

    event WorkspaceCreated(address indexed workspace, address indexed owner, bytes32 indexed ref, address operator);

    constructor(address usdc_, address usdt_, address reactor_, address[] memory payoutTokens) {
        require(usdc_.code.length > 0 && usdt_.code.length > 0 && reactor_.code.length > 0, "missing contract");
        usdc = usdc_; usdt = usdt_; reactor = reactor_;
        for (uint256 i; i < payoutTokens.length; i++) {
            require(payoutTokens[i].code.length > 0 && payoutTokens[i] != usdc_ && payoutTokens[i] != usdt_, "invalid payout token");
            isPayoutToken[payoutTokens[i]] = true;
        }
        implementation = address(new GrowthWorkspace(address(this), usdc_, usdt_, reactor_));
    }

    /// @notice The address is derived from the owner, so nobody else can take a customer's workspace.
    function addressOf(address owner, bytes32 ref) public view returns (address) {
        bytes32 codeHash = keccak256(_cloneCode());
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(owner, ref)), codeHash)))));
    }

    function createWorkspace(bytes32 ref, address operator, GrowthWorkspace.Policy calldata policy) external returns (address workspace) {
        bytes memory code = _cloneCode();
        bytes32 salt = keccak256(abi.encode(msg.sender, ref));
        assembly ("memory-safe") { workspace := create2(0, add(code, 0x20), mload(code), salt) }
        require(workspace != address(0), "workspace exists");
        isWorkspace[workspace] = true;
        GrowthWorkspace(workspace).initialize(msg.sender, ref, operator, policy);
        emit WorkspaceCreated(workspace, msg.sender, ref, operator);
    }

    /// @dev Standard EIP-1167 minimal proxy.
    function _cloneCode() private view returns (bytes memory) {
        return abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3");
    }
}
