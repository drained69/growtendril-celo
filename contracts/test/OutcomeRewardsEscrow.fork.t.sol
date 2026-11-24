// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import {OutcomeRewardsEscrow} from "../src/OutcomeRewardsEscrow.sol";

interface ForkVm { function warp(uint256) external; function prank(address) external; function store(address, bytes32, bytes32) external; }
interface IUSDC { function balanceOf(address) external view returns (uint256); function approve(address, uint256) external returns (bool); function decimals() external view returns (uint8); function symbol() external view returns (string memory); }

/// @notice Runs only against a local fork of Celo mainnet: forge test --match-contract Fork --fork-url https://forno.celo.org
contract OutcomeRewardsEscrowForkTest {
    ForkVm constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    IUSDC constant USDC = IUSDC(0xcebA9300f2b948710d2653dD7B07f33A8B32118C);
    address constant OWNER = address(0xA11CE);
    address constant CREATOR = address(0xCAFE);
    address constant ARBITER = address(0xBEEF);
    uint256 constant USDC_BALANCE_SLOT = 9;

    function testFullRewardLifecycleWithRealCeloUsdc() public {
        if (block.chainid != 42220) return;
        require(USDC.decimals() == 6 && keccak256(bytes(USDC.symbol())) == keccak256("USDC"), "unexpected token");
        OutcomeRewardsEscrow escrow = new OutcomeRewardsEscrow(address(USDC), 72 hours);
        vm.store(address(USDC), keccak256(abi.encode(OWNER, USDC_BALANCE_SLOT)), bytes32(uint256(100e6)));
        require(USDC.balanceOf(OWNER) == 100e6, "fork funding failed");
        uint256 deadline = block.timestamp + 14 days;
        bytes32 salt = keccak256("fork rehearsal");
        bytes32 id = escrow.campaignKey(OWNER, salt);
        vm.prank(OWNER); USDC.approve(address(escrow), 100e6);
        vm.prank(OWNER); escrow.createCampaign(salt, ARBITER, deadline, 100e6, 4e6, 3e6, 1e6, 3, 10, keccak256("terms"));
        require(USDC.balanceOf(address(escrow)) == 100e6, "escrow not funded");
        vm.warp(deadline);
        vm.prank(OWNER); escrow.queueReward(id, keccak256("post"), CREATOR, 80, 3, keccak256("evidence"));
        vm.warp(deadline + 72 hours);
        uint256 before = USDC.balanceOf(CREATOR);
        escrow.claim(id, keccak256("post"));
        require(USDC.balanceOf(CREATOR) - before == 9_400_000, "wrong reward");
        vm.warp(deadline + 8 days);
        vm.prank(OWNER); escrow.refundUnused(id);
        require(USDC.balanceOf(OWNER) == 90_600_000 && USDC.balanceOf(address(escrow)) == 0, "refund mismatch");
    }
}
