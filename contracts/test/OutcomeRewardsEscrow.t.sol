// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import {OutcomeRewardsEscrow} from "../src/OutcomeRewardsEscrow.sol";
interface Vm { function warp(uint256) external; function prank(address) external; function expectRevert(bytes calldata) external; }
contract TestUSDC {
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    function mint(address a,uint256 n) external {balanceOf[a]+=n;}
    function approve(address a,uint256 n) external returns(bool){allowance[msg.sender][a]=n;return true;}
    function transfer(address a,uint256 n) external returns(bool){require(balanceOf[msg.sender]>=n,"balance");balanceOf[msg.sender]-=n;balanceOf[a]+=n;return true;}
    function transferFrom(address a,address b,uint256 n) external returns(bool){require(balanceOf[a]>=n&&allowance[a][msg.sender]>=n,"allowance");allowance[a][msg.sender]-=n;balanceOf[a]-=n;balanceOf[b]+=n;return true;}
}
contract OutcomeRewardsEscrowTest {
    Vm constant vm=Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestUSDC token; OutcomeRewardsEscrow escrow;
    bytes32 constant SALT=keccak256("campaign");
    bytes32 CAMPAIGN;
    bytes32 constant REWARD=keccak256("post");
    address constant CREATOR=address(0xCAFE);
    address constant ARBITER=address(0xBEEF);
    address constant ATTACKER=address(0xBAD);
    uint256 deadline;
    function setUp() public {
        token=new TestUSDC();escrow=new OutcomeRewardsEscrow(address(token),3 days);
        token.mint(address(this),100e6);token.approve(address(escrow),100e6);
        deadline=block.timestamp+14 days;
        CAMPAIGN=escrow.campaignKey(address(this),SALT);
        escrow.createCampaign(SALT,ARBITER,deadline,100e6,4e6,3e6,1e6,3,10,keccak256("terms"));
    }
    function queue() private {vm.warp(deadline);escrow.queueReward(CAMPAIGN,REWARD,CREATOR,80,3,keccak256("evidence"));}
    function testExactRewardHoldAndOneTimeClaim() public {
        queue();vm.expectRevert("not claimable");escrow.claim(CAMPAIGN,REWARD);
        vm.warp(deadline+3 days);vm.prank(address(0xABCD));escrow.claim(CAMPAIGN,REWARD);
        require(token.balanceOf(CREATOR)==9_400_000,"wrong reward");
        vm.expectRevert("not claimable");escrow.claim(CAMPAIGN,REWARD);
    }
    function testRefundReducesOnlyPendingOutcomeBonus() public {
        queue();escrow.reduceOutcomes(CAMPAIGN,REWARD,1,keccak256("refund"));
        vm.expectRevert("only decrease outcomes");escrow.reduceOutcomes(CAMPAIGN,REWARD,2,keccak256("increase"));
        vm.warp(deadline+3 days);escrow.claim(CAMPAIGN,REWARD);
        require(token.balanceOf(CREATOR)==7_400_000,"base or quality changed");
        vm.expectRevert("cannot adjust");escrow.reduceOutcomes(CAMPAIGN,REWARD,0,keccak256("late"));
    }
    function testDisputeRequiresIndependentResolution() public {
        queue();vm.prank(CREATOR);escrow.dispute(CAMPAIGN,REWARD);
        vm.expectRevert("cannot adjust");escrow.reduceOutcomes(CAMPAIGN,REWARD,1,keccak256("refund"));
        vm.warp(deadline+3 days);vm.expectRevert("not claimable");escrow.claim(CAMPAIGN,REWARD);
        vm.expectRevert("arbiter only");escrow.resolve(CAMPAIGN,REWARD,true);
        vm.prank(ARBITER);escrow.resolve(CAMPAIGN,REWARD,true);escrow.claim(CAMPAIGN,REWARD);
        require(token.balanceOf(CREATOR)==9_400_000,"wrong reward");
    }
    function testUnusedRefundCannotTakeReservedRewards() public {
        queue();vm.warp(deadline+8 days);escrow.refundUnused(CAMPAIGN);
        require(token.balanceOf(address(escrow))==9_400_000,"reserved funds lost");
        escrow.claim(CAMPAIGN,REWARD);require(token.balanceOf(CREATOR)==9_400_000,"claim lost");
    }
    function testRejectsDuplicateRecipientAndOutcomesAboveCap() public {
        queue();vm.expectRevert("duplicate or invalid recipient");escrow.queueReward(CAMPAIGN,keccak256("another"),CREATOR,80,1,keccak256("e"));
        vm.expectRevert("reward exceeds terms");escrow.queueReward(CAMPAIGN,keccak256("another"),address(0x2222),80,4,keccak256("e"));
    }
    function testRejectsUnderfundingAndEarlyReview() public {
        vm.expectRevert("insufficient reward pool");escrow.createCampaign(keccak256("too small"),ARBITER,deadline,1e6,4e6,3e6,1e6,3,10,keccak256("terms"));
        vm.expectRevert("outside review window");escrow.queueReward(CAMPAIGN,REWARD,CREATOR,80,3,keccak256("e"));
    }
    function testRejectedDisputeReturnsReservedFundsToPool() public {
        queue();escrow.dispute(CAMPAIGN,REWARD);vm.prank(ARBITER);escrow.resolve(CAMPAIGN,REWARD,false);
        vm.warp(deadline+8 days);escrow.refundUnused(CAMPAIGN);require(token.balanceOf(address(this))==100e6,"funds missing");
        vm.expectRevert("not claimable");escrow.claim(CAMPAIGN,REWARD);
    }
    function testSilentArbiterCannotLockARewardForever() public {
        queue();escrow.dispute(CAMPAIGN,REWARD);
        vm.warp(deadline+14 days-1);vm.expectRevert("not claimable");escrow.claim(CAMPAIGN,REWARD);
        vm.warp(deadline+14 days);escrow.claim(CAMPAIGN,REWARD);
        require(token.balanceOf(CREATOR)==9_400_000,"reward stayed locked");
        vm.prank(ARBITER);vm.expectRevert("arbiter only");escrow.resolve(CAMPAIGN,REWARD,false);
    }
    function testArbiterCanStillRejectAfterHoldBeforeAnyClaim() public {
        queue();escrow.dispute(CAMPAIGN,REWARD);vm.warp(deadline+20 days);
        vm.prank(ARBITER);escrow.resolve(CAMPAIGN,REWARD,false);
        vm.expectRevert("not claimable");escrow.claim(CAMPAIGN,REWARD);
        require(token.balanceOf(CREATOR)==0,"rejected reward paid");
    }
    function testARewardCanOnlyBeDisputedOnce() public {
        queue();escrow.dispute(CAMPAIGN,REWARD);vm.prank(ARBITER);escrow.resolve(CAMPAIGN,REWARD,true);
        vm.expectRevert("cannot dispute");escrow.dispute(CAMPAIGN,REWARD);
        vm.warp(deadline+3 days);escrow.claim(CAMPAIGN,REWARD);require(token.balanceOf(CREATOR)==9_400_000,"release blocked");
    }
    function testAnotherFunderCannotTakeACampaignId() public {
        bytes32 salt=keccak256("next campaign");
        token.mint(ATTACKER,8e6);vm.prank(ATTACKER);token.approve(address(escrow),8e6);
        vm.prank(ATTACKER);escrow.createCampaign(salt,ARBITER,deadline,8e6,4e6,3e6,1e6,0,1,keccak256("fake"));
        require(escrow.campaignKey(ATTACKER,salt)!=escrow.campaignKey(address(this),salt),"ids collide");
        token.mint(address(this),100e6);token.approve(address(escrow),100e6);
        escrow.createCampaign(salt,ARBITER,deadline,100e6,4e6,3e6,1e6,3,10,keccak256("terms"));
        (address owner,,,,,,,,,,,bytes32 terms)=escrow.campaigns(escrow.campaignKey(address(this),salt));
        require(owner==address(this)&&terms==keccak256("terms"),"campaign was taken");
        vm.expectRevert("campaign exists");escrow.createCampaign(salt,ARBITER,deadline,100e6,4e6,3e6,1e6,3,10,keccak256("terms"));
    }
}
