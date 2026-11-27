// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;
import {CampaignEscrow} from "../src/CampaignEscrow.sol";

interface CampaignVm { function warp(uint256) external; function prank(address) external; function expectRevert(bytes calldata) external; }

contract CampaignTestUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address a, uint256 n) external { balanceOf[a] += n; }
    function approve(address a, uint256 n) external returns (bool) { allowance[msg.sender][a] = n; return true; }
    function transfer(address a, uint256 n) external returns (bool) { require(balanceOf[msg.sender] >= n, "balance"); balanceOf[msg.sender] -= n; balanceOf[a] += n; return true; }
    function transferFrom(address a, address b, uint256 n) external virtual returns (bool) { require(balanceOf[a] >= n && allowance[a][msg.sender] >= n, "allowance"); allowance[a][msg.sender] -= n; balanceOf[a] -= n; balanceOf[b] += n; return true; }
}

/// Takes a fee on transfer, so the escrow would receive less than the budget it records.
contract ShortUSDC is CampaignTestUSDC {
    function transferFrom(address a, address b, uint256 n) external override returns (bool) { require(balanceOf[a] >= n && allowance[a][msg.sender] >= n, "allowance"); allowance[a][msg.sender] -= n; balanceOf[a] -= n; balanceOf[b] += n - 1; return true; }
}

contract CampaignEscrowTest {
    CampaignVm constant vm = CampaignVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    CampaignTestUSDC token;
    CampaignEscrow escrow;
    bytes32 constant SALT = keccak256("campaign");
    bytes32 constant TERMS = keccak256("terms");
    bytes32 constant EVIDENCE = keccak256("evidence");
    bytes32 constant REASON = keccak256("not the agreed post");
    address constant AGENT = address(0xA9E);
    address constant NEW_AGENT = address(0xA9F);
    address constant CREATOR = address(0xCAFE);
    address constant STRANGER = address(0xBAD);
    uint256 constant HOLD = 3 days;
    bytes32 id;
    uint256 deadline;

    function setUp() public {
        token = new CampaignTestUSDC();
        escrow = new CampaignEscrow(address(token), HOLD);
        token.mint(address(this), 100e6);
        token.approve(address(escrow), 100e6);
        deadline = block.timestamp + 14 days;
        id = escrow.campaignKey(address(this), SALT);
        // Max reward per person = 4 + 3 + 1 * 3 = 10 USDC, so 100 USDC funds exactly 10 people.
        escrow.createCampaign(SALT, AGENT, deadline, 100e6, 4e6, 3e6, 1e6, 3, 10, TERMS);
    }

    function queueAs(address who, bytes32 rewardId, address recipient, uint256 quality, uint256 outcomes) private {
        vm.prank(who);
        escrow.queueReward(id, rewardId, recipient, quality, outcomes, EVIDENCE);
    }
    function available() private view returns (uint256 a) { (,,, a,,,,,,,,) = escrow.campaigns(id); }
    function reserved() private view returns (uint256 r) { (,,,, r,,,,,,,) = escrow.campaigns(id); }
    function queued() private view returns (uint256 q) { (,,,,,,,,,, q,) = escrow.campaigns(id); }
    function status(bytes32 rewardId) private view returns (CampaignEscrow.Status s) { (,,,,,, s) = escrow.rewards(id, rewardId); }
    function claimableAt(bytes32 rewardId) private view returns (uint256 t) { (,,,, t,,) = escrow.rewards(id, rewardId); }

    function testAgentApprovesBeforeDeadlineAndAnyoneRelaysAfterHold() public {
        queueAs(AGENT, "r1", CREATOR, 80, 3);
        require(status("r1") == CampaignEscrow.Status.Held && reserved() == 9_400_000, "not held");
        vm.expectRevert("not claimable"); escrow.claim(id, "r1");
        vm.warp(block.timestamp + HOLD);
        vm.prank(STRANGER); escrow.claim(id, "r1");
        require(token.balanceOf(CREATOR) == 9_400_000 && status("r1") == CampaignEscrow.Status.Paid && reserved() == 0, "wrong payout");
        vm.expectRevert("not claimable"); escrow.claim(id, "r1");
    }

    function testApprovalWindowClosesAfterReviewWindow() public {
        vm.warp(deadline + 7 days);
        queueAs(address(this), "owner-last", address(0x1001), 0, 0);
        queueAs(AGENT, "agent-last", address(0x1002), 0, 0);
        vm.warp(deadline + 7 days + 1);
        vm.expectRevert("campaign closed"); escrow.queueReward(id, "late", address(0x1003), 0, 0, EVIDENCE);
        vm.prank(AGENT); vm.expectRevert("campaign closed"); escrow.queueReward(id, "late2", address(0x1004), 0, 0, EVIDENCE);
    }

    function testOnlyOwnerOrCurrentAgentCanApprove() public {
        vm.prank(STRANGER); vm.expectRevert("not authorized"); escrow.queueReward(id, "s", CREATOR, 0, 0, EVIDENCE);
        escrow.setAgent(id, address(0));
        vm.prank(AGENT); vm.expectRevert("not authorized"); escrow.queueReward(id, "a", CREATOR, 0, 0, EVIDENCE);
        escrow.setAgent(id, NEW_AGENT);
        vm.prank(AGENT); vm.expectRevert("not authorized"); escrow.queueReward(id, "a", CREATOR, 0, 0, EVIDENCE);
        queueAs(NEW_AGENT, "n", CREATOR, 0, 0);
        require(status("n") == CampaignEscrow.Status.Held, "new agent cannot approve");
    }

    function testOnlyOwnerChangesAgent() public {
        vm.prank(AGENT); vm.expectRevert("owner only"); escrow.setAgent(id, AGENT);
        vm.prank(STRANGER); vm.expectRevert("owner only"); escrow.setAgent(id, STRANGER);
        vm.expectRevert("invalid agent"); escrow.setAgent(id, address(this));
        vm.expectRevert("owner only"); escrow.setAgent(keccak256("missing"), AGENT);
    }

    function testFormulaCapsAndSlots() public {
        vm.prank(AGENT); vm.expectRevert("reward exceeds terms"); escrow.queueReward(id, "q", CREATOR, 101, 0, EVIDENCE);
        vm.prank(AGENT); vm.expectRevert("reward exceeds terms"); escrow.queueReward(id, "o", CREATOR, 0, 4, EVIDENCE);
        for (uint256 i; i < 10; i++) queueAs(AGENT, bytes32(i + 1), address(uint160(0x2000 + i)), 100, 3);
        require(available() == 0 && reserved() == 100e6 && queued() == 10, "budget not exact");
        vm.prank(AGENT); vm.expectRevert("slots or evidence"); escrow.queueReward(id, "11", address(0x3000), 0, 0, EVIDENCE);
    }

    function testOneRewardPerRecipientAndValidInputs() public {
        queueAs(AGENT, "r1", CREATOR, 0, 0);
        vm.expectRevert("duplicate or invalid recipient"); escrow.queueReward(id, "r2", CREATOR, 0, 0, EVIDENCE);
        vm.prank(AGENT); vm.expectRevert("duplicate or invalid recipient"); escrow.queueReward(id, "r1", address(0x4001), 0, 0, EVIDENCE);
        vm.prank(AGENT); vm.expectRevert("duplicate or invalid recipient"); escrow.queueReward(id, bytes32(0), address(0x4002), 0, 0, EVIDENCE);
        vm.prank(AGENT); vm.expectRevert("duplicate or invalid recipient"); escrow.queueReward(id, "r3", address(0), 0, 0, EVIDENCE);
        vm.prank(AGENT); vm.expectRevert("duplicate or invalid recipient"); escrow.queueReward(id, "r4", address(this), 0, 0, EVIDENCE);
        vm.prank(AGENT); vm.expectRevert("duplicate or invalid recipient"); escrow.queueReward(id, "r5", AGENT, 0, 0, EVIDENCE);
        vm.prank(AGENT); vm.expectRevert("slots or evidence"); escrow.queueReward(id, "r6", address(0x4003), 0, 0, bytes32(0));
    }

    function testObjectionReturnsMoneyAndFreesSlot() public {
        queueAs(AGENT, "r1", CREATOR, 80, 3);
        escrow.object(id, "r1", REASON);
        require(status("r1") == CampaignEscrow.Status.Objected && available() == 100e6 && reserved() == 0 && queued() == 0, "objection not applied");
        require(!escrow.hasReward(id, CREATOR) && escrow.objectedTo(id, CREATOR), "recipient flags wrong");
        vm.warp(block.timestamp + HOLD);
        vm.expectRevert("not claimable"); escrow.claim(id, "r1");
        require(token.balanceOf(CREATOR) == 0, "objected reward paid");
    }

    function testObjectionEndsWhenHoldEnds() public {
        queueAs(AGENT, "r1", CREATOR, 0, 0);
        vm.warp(claimableAt("r1"));
        vm.expectRevert("cannot object"); escrow.object(id, "r1", REASON);
        escrow.claim(id, "r1");
        require(token.balanceOf(CREATOR) == 4e6, "payout blocked");
    }

    function testOnlyOwnerObjectsOnceWithAReason() public {
        queueAs(AGENT, "r1", CREATOR, 0, 0);
        vm.prank(STRANGER); vm.expectRevert("cannot object"); escrow.object(id, "r1", REASON);
        vm.prank(AGENT); vm.expectRevert("cannot object"); escrow.object(id, "r1", REASON);
        vm.prank(CREATOR); vm.expectRevert("cannot object"); escrow.object(id, "r1", REASON);
        vm.expectRevert("cannot object"); escrow.object(id, "r1", bytes32(0));
        escrow.object(id, "r1", REASON);
        vm.expectRevert("cannot object"); escrow.object(id, "r1", REASON);
    }

    function testAfterObjectionOnlyOwnerApprovesThatPersonAgain() public {
        queueAs(AGENT, "r1", CREATOR, 0, 0);
        escrow.object(id, "r1", REASON);
        vm.prank(AGENT); vm.expectRevert("not authorized"); escrow.queueReward(id, "r2", CREATOR, 0, 0, EVIDENCE);
        vm.expectRevert("duplicate or invalid recipient"); escrow.queueReward(id, "r1", CREATOR, 0, 0, EVIDENCE);
        queueAs(address(this), "r2", CREATOR, 0, 0);
        vm.warp(block.timestamp + HOLD); escrow.claim(id, "r2");
        require(token.balanceOf(CREATOR) == 4e6, "owner fix not paid");
    }

    function testRefundOnlyUnusedMoneyAfterReviewWindow() public {
        queueAs(AGENT, "r1", CREATOR, 80, 3);
        vm.warp(deadline + 7 days);
        queueAs(AGENT, "late", address(0x5001), 0, 0); // Approved at the last moment; its hold runs past the window.
        vm.expectRevert("review still open"); escrow.refundUnused(id);
        vm.warp(deadline + 7 days + 1);
        vm.prank(STRANGER); vm.expectRevert("review still open"); escrow.refundUnused(id);
        uint256 before = token.balanceOf(address(this));
        escrow.refundUnused(id);
        require(token.balanceOf(address(this)) - before == 100e6 - 9_400_000 - 4e6, "refund touched reserved money");
        vm.expectRevert("nothing unused"); escrow.refundUnused(id);
        escrow.object(id, "late", REASON);
        escrow.refundUnused(id);
        require(token.balanceOf(address(this)) - before == 100e6 - 9_400_000, "objected money not refundable");
        escrow.claim(id, "r1");
        require(token.balanceOf(CREATOR) == 9_400_000 && token.balanceOf(address(escrow)) == 0, "balances wrong");
    }

    function testCampaignIdIsBoundToFunderAndTermsAreChecked() public {
        CampaignTestUSDC other = token;
        other.mint(STRANGER, 100e6);
        vm.prank(STRANGER); other.approve(address(escrow), 100e6);
        vm.prank(STRANGER); escrow.createCampaign(SALT, AGENT, deadline, 10e6, 1e6, 0, 0, 0, 10, TERMS);
        require(escrow.campaignKey(STRANGER, SALT) != id, "funder can take another's ID");
        (address owner,,,,,,,,,,,) = escrow.campaigns(id);
        require(owner == address(this), "campaign overwritten");
        token.mint(address(this), 100e6); token.approve(address(escrow), 100e6);
        vm.expectRevert("campaign exists"); escrow.createCampaign(SALT, AGENT, deadline, 10e6, 1e6, 0, 0, 0, 10, TERMS);
        vm.expectRevert("campaign exists"); escrow.createCampaign(bytes32(0), AGENT, deadline, 10e6, 1e6, 0, 0, 0, 10, TERMS);
        vm.expectRevert("invalid terms"); escrow.createCampaign("s1", AGENT, block.timestamp, 10e6, 1e6, 0, 0, 0, 10, TERMS);
        vm.expectRevert("invalid terms"); escrow.createCampaign("s2", AGENT, block.timestamp + 366 days, 10e6, 1e6, 0, 0, 0, 10, TERMS);
        vm.expectRevert("invalid terms"); escrow.createCampaign("s3", address(this), deadline, 10e6, 1e6, 0, 0, 0, 10, TERMS);
        vm.expectRevert("invalid terms"); escrow.createCampaign("s4", AGENT, deadline, 10e6, 1e6, 0, 0, 0, 0, TERMS);
        vm.expectRevert("invalid terms"); escrow.createCampaign("s5", AGENT, deadline, 10e6, 0, 0, 0, 0, 10, TERMS);
        vm.expectRevert("invalid terms"); escrow.createCampaign("s6", AGENT, deadline, 10e6, 1e6, 0, 0, 0, 10, bytes32(0));
        vm.expectRevert("insufficient reward pool"); escrow.createCampaign("s7", AGENT, deadline, 10e6 - 1, 1e6, 0, 0, 0, 10, TERMS);
        vm.expectRevert("insufficient reward pool"); escrow.createCampaign("s8", AGENT, deadline, 100e6, 1e6, 0, 1e6, 101, 1, TERMS);
        escrow.createCampaign("manual", address(0), deadline, 10e6, 1e6, 0, 0, 0, 10, TERMS);
    }

    function testShortFundingIsRejected() public {
        ShortUSDC short = new ShortUSDC();
        CampaignEscrow e = new CampaignEscrow(address(short), HOLD);
        short.mint(address(this), 10e6); short.approve(address(e), 10e6);
        vm.expectRevert("funding failed"); e.createCampaign(SALT, AGENT, deadline, 10e6, 1e6, 0, 0, 0, 10, TERMS);
    }

    function testRejectsBadConfiguration() public {
        vm.expectRevert("invalid configuration"); new CampaignEscrow(address(token), 1 days - 1);
        vm.expectRevert("invalid configuration"); new CampaignEscrow(address(0), HOLD);
    }

    /// A stolen agent key approves rewards to the attacker's addresses. Switching the agent off and objecting
    /// during the hold recovers every dollar.
    function testOwnerRecoversEverythingFromAStolenAgentKey() public {
        for (uint256 i; i < 5; i++) queueAs(AGENT, bytes32(i + 1), address(uint160(0xBAD0 + i)), 100, 3);
        escrow.setAgent(id, address(0));
        vm.prank(AGENT); vm.expectRevert("not authorized"); escrow.queueReward(id, "more", address(0xBADF), 100, 3, EVIDENCE);
        for (uint256 i; i < 5; i++) escrow.object(id, bytes32(i + 1), REASON);
        require(available() == 100e6 && reserved() == 0 && queued() == 0, "money not recovered");
        vm.warp(deadline + 7 days + 1);
        uint256 before = token.balanceOf(address(this));
        escrow.refundUnused(id);
        require(token.balanceOf(address(this)) - before == 100e6, "owner did not get everything back");
        for (uint256 i; i < 5; i++) require(token.balanceOf(address(uint160(0xBAD0 + i))) == 0, "attacker paid");
    }
}
