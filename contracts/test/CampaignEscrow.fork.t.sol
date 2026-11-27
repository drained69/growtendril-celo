// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import {CampaignEscrow} from "../src/CampaignEscrow.sol";

interface CampaignForkVm { function warp(uint256) external; function prank(address) external; function store(address, bytes32, bytes32) external; }
interface ICeloUSDC { function balanceOf(address) external view returns (uint256); function approve(address, uint256) external returns (bool); function decimals() external view returns (uint8); function symbol() external view returns (string memory); }

/// @notice Runs only against a local fork of Celo mainnet: forge test --match-contract CampaignEscrowFork --fork-url https://forno.celo.org
contract CampaignEscrowForkTest {
    CampaignForkVm constant vm = CampaignForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ICeloUSDC constant USDC = ICeloUSDC(0xcebA9300f2b948710d2653dD7B07f33A8B32118C);
    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xA9E);
    address constant ALICE = address(0xA1);
    address constant BOB = address(0xB0);
    uint256 constant USDC_BALANCE_SLOT = 9;

    function testOpenCampaignLifecycleWithRealCeloUsdc() public {
        if (block.chainid != 42220) return;
        require(USDC.decimals() == 6 && keccak256(bytes(USDC.symbol())) == keccak256("USDC"), "unexpected token");
        CampaignEscrow escrow = new CampaignEscrow(address(USDC), 72 hours);
        vm.store(address(USDC), keccak256(abi.encode(OWNER, USDC_BALANCE_SLOT)), bytes32(uint256(20e6)));
        require(USDC.balanceOf(OWNER) == 20e6, "fork funding failed");
        uint256 deadline = block.timestamp + 2 days;
        bytes32 salt = keccak256("fork open campaign");
        bytes32 id = escrow.campaignKey(OWNER, salt);
        vm.prank(OWNER); USDC.approve(address(escrow), 20e6);
        vm.prank(OWNER); escrow.createCampaign(salt, AGENT, deadline, 20e6, 5e6, 0, 0, 0, 4, keccak256("terms"));
        require(USDC.balanceOf(address(escrow)) == 20e6, "escrow not funded");
        // The agent approves two claims during the campaign; the owner objects to one.
        vm.prank(AGENT); escrow.queueReward(id, keccak256("alice"), ALICE, 100, 0, keccak256("alice proof"));
        vm.prank(AGENT); escrow.queueReward(id, keccak256("bob"), BOB, 100, 0, keccak256("bob proof"));
        vm.prank(OWNER); escrow.object(id, keccak256("bob"), keccak256("post was deleted"));
        vm.warp(block.timestamp + 72 hours);
        escrow.claim(id, keccak256("alice"));
        require(USDC.balanceOf(ALICE) == 5e6 && USDC.balanceOf(BOB) == 0, "wrong payouts");
        vm.warp(deadline + 7 days + 1);
        vm.prank(OWNER); escrow.refundUnused(id);
        require(USDC.balanceOf(OWNER) == 15e6 && USDC.balanceOf(address(escrow)) == 0, "refund mismatch");
    }
}
