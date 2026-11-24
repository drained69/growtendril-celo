// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {GrowthFactory} from "../src/protocol/GrowthFactory.sol";
import {GrowthWorkspace} from "../src/protocol/GrowthWorkspace.sol";
import {GrowthLedger} from "../src/protocol/GrowthLedger.sol";

interface HVm { function warp(uint256) external; function prank(address) external; function expectRevert(bytes calldata) external; }

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address a, uint256 n) external { balanceOf[a] += n; }
    function approve(address a, uint256 n) external returns (bool) { allowance[msg.sender][a] = n; return true; }
    function transfer(address a, uint256 n) external returns (bool) { require(balanceOf[msg.sender] >= n, "balance"); balanceOf[msg.sender] -= n; balanceOf[a] += n; return true; }
    function transferFrom(address a, address b, uint256 n) external returns (bool) { require(balanceOf[a] >= n && allowance[a][msg.sender] >= n, "allowance"); allowance[a][msg.sender] -= n; balanceOf[a] -= n; balanceOf[b] += n; return true; }
}
contract MockReactor {
    function fill(MockToken sell, MockToken buy, uint256 sold, uint256 bought) external {
        sell.transferFrom(msg.sender, address(this), sold);
        buy.mint(msg.sender, bought);
    }
}

contract GrowthProtocolTest {
    HVm constant vm = HVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant OWNER = address(0xA11CE);
    address constant AGENT = address(0xA6E7);
    address constant APPROVER = address(0xB0B);
    address constant CREATOR = address(0xCAFE);
    address constant STRANGER = address(0xBAD);
    address constant SELLER = address(0x5E11);
    bytes32 constant MISSION = keccak256("mission");
    bytes32 constant EXPERIMENT = keccak256("experiment");
    MockToken usdc; MockToken usdt; MockToken cngn; MockReactor reactor;
    GrowthFactory factory; GrowthLedger ledger; GrowthWorkspace ws;
    uint256 nonce;

    function policy(bool autonomy) private pure returns (GrowthWorkspace.Policy memory) {
        return GrowthWorkspace.Policy(autonomy, 5e6, 10e6, 20e6, autonomy ? 3 : 0, autonomy ? 124 : 127);
    }
    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockToken(); usdt = new MockToken(); cngn = new MockToken(); reactor = new MockReactor();
        address[] memory tokens = new address[](1); tokens[0] = address(cngn);
        factory = new GrowthFactory(address(usdc), address(usdt), address(reactor), tokens);
        ledger = new GrowthLedger(address(factory));
        vm.prank(OWNER); ws = GrowthWorkspace(factory.createWorkspace(keccak256("project"), AGENT, policy(false)));
        usdc.mint(address(ws), 100e6); usdt.mint(address(ws), 100e6);
        vm.prank(OWNER); ws.setRole(APPROVER, 2);
        uint8[] memory cats = new uint8[](2); cats[0] = 0; cats[1] = 2;
        uint64[] memory budgets = new uint64[](2); budgets[0] = 20e6; budgets[1] = 40e6;
        vm.prank(OWNER); ws.openMission(MISSION, 60e6, uint64(block.timestamp + 30 days), keccak256("goal"), cats, budgets);
        vm.prank(AGENT); ws.openExperiment(EXPERIMENT, MISSION, 30e6, keccak256("terms"));
        vm.prank(AGENT); ws.registerPayee(CREATOR);
    }
    function request(uint64 amount, GrowthWorkspace.Kind kind, address recipient, uint8 category) private returns (GrowthWorkspace.IntentRequest memory) {
        return GrowthWorkspace.IntentRequest(keccak256(abi.encode("intent", ++nonce)), MISSION, EXPERIMENT, recipient, address(usdc), address(0), amount, uint64(block.timestamp + 7 days), category, kind, 0, keccak256("evidence"));
    }
    function pay(uint64 amount) private returns (bytes32 id) {
        GrowthWorkspace.IntentRequest memory r = request(amount, GrowthWorkspace.Kind.Payment, CREATOR, 2);
        vm.prank(AGENT); ws.propose(r); return r.id;
    }
    function stateOf(bytes32 id) private view returns (GrowthWorkspace.State) { return ws.intentOf(id).state; }

    function testWorkspaceBelongsToItsOwnerAndCannotBeReinitialized() public {
        require(ws.owner() == OWNER && factory.isWorkspace(address(ws)) && factory.addressOf(OWNER, keccak256("project")) == address(ws), "bad setup");
        vm.expectRevert("already initialized"); ws.initialize(STRANGER, keccak256("x"), AGENT, policy(true));
        vm.prank(OWNER); vm.expectRevert("workspace exists"); factory.createWorkspace(keccak256("project"), AGENT, policy(false));
        vm.prank(STRANGER); address other = factory.createWorkspace(keccak256("project"), AGENT, policy(false));
        require(other != address(ws), "workspace was taken");
    }
    function testPaymentToAPersonAlwaysNeedsAHuman() public {
        vm.prank(OWNER); ws.setPolicy(policy(true));
        bytes32 id = pay(5e6);
        require(stateOf(id) == GrowthWorkspace.State.Pending, "not pending");
        vm.prank(AGENT); vm.expectRevert("not executable"); ws.execute(id);
        vm.prank(APPROVER); ws.approve(id);
        vm.prank(AGENT); ws.execute(id);
        require(usdc.balanceOf(CREATOR) == 5e6, "not paid");
        vm.prank(AGENT); vm.expectRevert("not executable"); ws.execute(id);
    }
    function testAgentCannotApproveWithdrawOrChangeRules() public {
        bytes32 id = pay(5e6);
        vm.prank(AGENT); vm.expectRevert("not authorized"); ws.approve(id);
        vm.prank(AGENT); vm.expectRevert("owner only"); ws.withdraw(address(usdc), AGENT, 1);
        vm.prank(AGENT); vm.expectRevert("not authorized"); ws.setPolicy(policy(true));
        vm.prank(AGENT); vm.expectRevert("not authorized"); ws.setFrozen(false);
        vm.prank(AGENT); vm.expectRevert("not authorized"); ws.setRole(AGENT, 7);
    }
    function testProposerCannotApproveItsOwnPayment() public {
        vm.prank(OWNER); ws.setRole(AGENT, 6);
        bytes32 id = pay(5e6);
        vm.prank(AGENT); vm.expectRevert("proposer cannot approve"); ws.approve(id);
    }
    function testPersonWhoChangedAPayeeWaitsBeforeApprovingIt() public {
        bytes32 id = pay(5e6);
        vm.prank(OWNER); ws.registerPayee(CREATOR);
        vm.prank(OWNER); vm.expectRevert("payee hold"); ws.approve(id);
        vm.prank(APPROVER); ws.approve(id);
        bytes32 second = pay(1e6);
        vm.warp(block.timestamp + 1 days);
        vm.prank(OWNER); ws.approve(second);
    }
    function testHardLimitsAreDenied() public {
        GrowthWorkspace.IntentRequest memory r = request(21e6, GrowthWorkspace.Kind.Payment, CREATOR, 2);
        vm.prank(AGENT); vm.expectRevert("hard ceiling"); ws.propose(r);
        r = request(1e6, GrowthWorkspace.Kind.Payment, STRANGER, 2);
        vm.prank(AGENT); vm.expectRevert("unknown payee or experiment"); ws.propose(r);
        r = request(1e6, GrowthWorkspace.Kind.Payment, CREATOR, 2); r.token = address(cngn);
        vm.prank(AGENT); vm.expectRevert("token not allowed"); ws.propose(r);
        pay(20e6);
        r = request(11e6, GrowthWorkspace.Kind.Payment, CREATOR, 2);
        vm.prank(AGENT); vm.expectRevert("experiment budget"); ws.propose(r);
    }
    function testMissionBudgetCapsExperimentsAndPayments() public {
        vm.prank(AGENT); vm.expectRevert("mission budget"); ws.openExperiment(keccak256("too big"), MISSION, 31e6, keccak256("t"));
        vm.prank(OWNER); vm.expectRevert("below commitments"); ws.updateMission(MISSION, 29e6, uint64(block.timestamp + 1 days), true);
    }
    function testKillSwitchStopsEverythingButOwnerExit() public {
        bytes32 id = pay(5e6);
        vm.prank(APPROVER); ws.approve(id);
        vm.prank(APPROVER); ws.setFrozen(true);
        vm.prank(AGENT); vm.expectRevert("frozen"); ws.execute(id);
        vm.prank(APPROVER); vm.expectRevert("not authorized"); ws.setFrozen(false);
        vm.prank(OWNER); ws.withdraw(address(usdc), OWNER, 95e6);
        vm.prank(OWNER); vm.expectRevert("funds reserved"); ws.withdraw(address(usdc), OWNER, 1);
        vm.prank(OWNER); ws.setFrozen(false);
        vm.prank(AGENT); ws.execute(id);
        require(usdc.balanceOf(CREATOR) == 5e6, "reserved payment lost");
    }
    function testRejectAndExpiryReleaseBudget() public {
        bytes32 a = pay(20e6);
        vm.prank(APPROVER); ws.reject(a);
        require(ws.reserved(address(usdc)) == 0, "still reserved");
        bytes32 b = pay(20e6);
        vm.expectRevert("not expired"); ws.cancelExpired(b);
        vm.warp(block.timestamp + 7 days);
        vm.prank(APPROVER); vm.expectRevert("not pending"); ws.approve(b);
        vm.prank(STRANGER); ws.cancelExpired(b);
        (,uint64 committed,,,,) = ws.missions(MISSION);
        require(committed == 0, "budget not released");
    }
    function testAutonomousResearchStaysInsideLimits() public {
        vm.prank(OWNER); ws.setPolicy(policy(true));
        vm.prank(OWNER); ws.setService(SELLER, true);
        GrowthWorkspace.IntentRequest memory r = request(5e6, GrowthWorkspace.Kind.Service, SELLER, 0);
        vm.prank(AGENT); ws.propose(r);
        require(stateOf(r.id) == GrowthWorkspace.State.Approved, "should be autonomous");
        vm.prank(AGENT); ws.execute(r.id);
        GrowthWorkspace.IntentRequest memory second = request(5e6, GrowthWorkspace.Kind.Service, SELLER, 0);
        vm.prank(AGENT); ws.propose(second); vm.prank(AGENT); ws.execute(second.id);
        GrowthWorkspace.IntentRequest memory third = request(1e6, GrowthWorkspace.Kind.Service, SELLER, 0);
        vm.prank(AGENT); ws.propose(third);
        require(stateOf(third.id) == GrowthWorkspace.State.Pending, "daily limit ignored");
        GrowthWorkspace.IntentRequest memory unknown = request(1e6, GrowthWorkspace.Kind.Service, STRANGER, 0);
        vm.warp(block.timestamp + 1 days);
        vm.prank(AGENT); ws.propose(unknown);
        require(stateOf(unknown.id) == GrowthWorkspace.State.Pending, "unapproved service ran");
    }
    function testAutonomousIntentCannotBypassDailyLimitAtExecution() public {
        vm.prank(OWNER); ws.setPolicy(policy(true));
        vm.prank(OWNER); ws.setService(SELLER, true);
        GrowthWorkspace.IntentRequest memory a = request(5e6, GrowthWorkspace.Kind.Service, SELLER, 0);
        GrowthWorkspace.IntentRequest memory b = request(5e6, GrowthWorkspace.Kind.Service, SELLER, 0);
        GrowthWorkspace.IntentRequest memory c = request(5e6, GrowthWorkspace.Kind.Service, SELLER, 0);
        vm.prank(AGENT); ws.propose(a); vm.prank(AGENT); ws.propose(b); vm.prank(AGENT); ws.propose(c);
        vm.prank(AGENT); ws.execute(a.id); vm.prank(AGENT); ws.execute(b.id);
        vm.prank(AGENT); vm.expectRevert("daily limit"); ws.execute(c.id);
    }
    function corridor(uint256 minPayout) private returns (bytes32) {
        GrowthWorkspace.IntentRequest memory r = request(10e6, GrowthWorkspace.Kind.Payment, CREATOR, 2);
        r.token = address(usdt); r.payoutToken = address(cngn); r.minPayout = minPayout;
        vm.prank(AGENT); ws.propose(r);
        vm.prank(APPROVER); ws.approve(r.id);
        return r.id;
    }
    function testCorridorConvertsAndDeliversAtomically() public {
        bytes32 id = corridor(14_000e6);
        vm.prank(AGENT); ws.executeCorridor(id, abi.encodeCall(MockReactor.fill, (usdt, cngn, 10e6, 14_500e6)));
        require(cngn.balanceOf(CREATOR) == 14_500e6 && cngn.balanceOf(address(ws)) == 0, "not delivered");
        require(usdt.allowance(address(ws), address(reactor)) == 0, "allowance left open");
    }
    function testCorridorRevertsBelowApprovedMinimum() public {
        bytes32 id = corridor(14_000e6);
        vm.prank(AGENT); vm.expectRevert("below minimum payout"); ws.executeCorridor(id, abi.encodeCall(MockReactor.fill, (usdt, cngn, 10e6, 13_999e6)));
        require(usdt.balanceOf(address(ws)) == 100e6 && stateOf(id) == GrowthWorkspace.State.Approved, "partial execution");
    }
    function testCorridorCannotSpendAboveTheApprovedAmount() public {
        bytes32 id = corridor(14_000e6);
        vm.prank(AGENT); vm.expectRevert("swap failed"); ws.executeCorridor(id, abi.encodeCall(MockReactor.fill, (usdt, cngn, 11e6, 15_000e6)));
    }
    function testReallocationMovesOnlyUnspentBudget() public {
        vm.prank(AGENT); ws.openExperiment(keccak256("winner"), MISSION, 10e6, keccak256("t"));
        vm.prank(AGENT); vm.expectRevert("admin required"); ws.reallocate(EXPERIMENT, keccak256("winner"), 5e6);
        pay(20e6);
        vm.prank(OWNER); vm.expectRevert("source lacks budget"); ws.reallocate(EXPERIMENT, keccak256("winner"), 11e6);
        vm.prank(OWNER); ws.reallocate(EXPERIMENT, keccak256("winner"), 10e6);
        (,uint64 budget,,,) = ws.experiments(keccak256("winner"));
        require(budget == 20e6, "move failed");
    }
    function testOwnershipIsTwoStep() public {
        vm.prank(OWNER); ws.offerOwnership(APPROVER);
        vm.prank(STRANGER); vm.expectRevert("not offered"); ws.acceptOwnership();
        vm.prank(APPROVER); ws.acceptOwnership();
        require(ws.owner() == APPROVER, "ownership");
    }
    function testLedgerIsAHashChainOnlyWritersCanExtend() public {
        vm.prank(STRANGER); vm.expectRevert("not authorized"); ledger.commitCheckpoint(address(ws), keccak256("r"), 1, bytes32(0));
        vm.prank(AGENT); ledger.commitCheckpoint(address(ws), keccak256("r"), 3, bytes32(0));
        vm.prank(AGENT); vm.expectRevert("stale checkpoint"); ledger.commitCheckpoint(address(ws), keccak256("r2"), 3, bytes32(0));
        bytes32 current = ledger.head(address(ws));
        vm.prank(AGENT); ledger.commitCheckpoint(address(ws), keccak256("r2"), 3, current);
        require(ledger.checkpointCount(address(ws)) == 2, "count");
    }
    function testAnyoneCanProveARecordInACheckpoint() public {
        bytes32 a = keccak256("receipt a"); bytes32 b = keccak256("receipt b");
        bytes32 hashedA = keccak256(abi.encode(a)); bytes32 hashedB = keccak256(abi.encode(b));
        bytes32 root = hashedA < hashedB ? keccak256(abi.encodePacked(hashedA, hashedB)) : keccak256(abi.encodePacked(hashedB, hashedA));
        vm.prank(AGENT); ledger.commitCheckpoint(address(ws), root, 2, bytes32(0));
        bytes32[] memory proof = new bytes32[](1); proof[0] = hashedB;
        require(ledger.verifyRecord(address(ws), 1, a, proof), "valid proof rejected");
        proof[0] = keccak256("forged");
        require(!ledger.verifyRecord(address(ws), 1, a, proof), "forged proof accepted");
        require(!ledger.verifyRecord(address(ws), 1, root, new bytes32[](0)), "tree node accepted as a record");
    }
    function testTighterPolicyStopsIntentsQueuedEarlier() public {
        vm.prank(OWNER); ws.setPolicy(policy(true));
        vm.prank(OWNER); ws.setService(SELLER, true);
        GrowthWorkspace.IntentRequest memory a = request(5e6, GrowthWorkspace.Kind.Service, SELLER, 0);
        GrowthWorkspace.IntentRequest memory b = request(5e6, GrowthWorkspace.Kind.Service, SELLER, 0);
        vm.prank(AGENT); ws.propose(a); vm.prank(AGENT); ws.propose(b);
        vm.prank(OWNER); ws.setPolicy(policy(false));
        vm.prank(AGENT); vm.expectRevert("needs approval"); ws.execute(a.id);
        vm.prank(OWNER); ws.setPolicy(policy(true));
        vm.prank(OWNER); ws.setService(SELLER, false);
        vm.prank(AGENT); vm.expectRevert("needs approval"); ws.execute(b.id);
    }
    function testLoweredCeilingStopsAnApprovedPayment() public {
        bytes32 id = pay(15e6);
        vm.prank(APPROVER); ws.approve(id);
        vm.prank(OWNER); ws.setPolicy(GrowthWorkspace.Policy(false, 5e6, 10e6, 10e6, 0, 127));
        vm.prank(AGENT); vm.expectRevert("hard ceiling"); ws.execute(id);
    }
    function testMissionCannotBeResetToWipeCommitments() public {
        pay(5e6);
        vm.prank(OWNER); vm.expectRevert("invalid mission"); ws.updateMission(MISSION, 60e6, 0, false);
    }
    function testRejectingAfterStopReturnsBudgetToMission() public {
        bytes32 id = pay(5e6);
        vm.prank(OWNER); ws.stopExperiment(EXPERIMENT);
        vm.prank(OWNER); ws.reject(id);
        (,,uint64 allocated,,,) = ws.missions(MISSION);
        require(allocated == 0, "budget leaked");
    }
    function testOperatorCannotStopExperiments() public {
        vm.prank(AGENT); vm.expectRevert("not authorized"); ws.stopExperiment(EXPERIMENT);
    }
    function testOwnerCanClearJunkProposalsAtOnce() public {
        bytes32[] memory ids = new bytes32[](3);
        ids[0] = pay(10e6); ids[1] = pay(10e6); ids[2] = pay(10e6);
        vm.prank(OWNER); vm.expectRevert("funds reserved"); ws.withdraw(address(usdc), OWNER, 71e6);
        vm.prank(STRANGER); vm.expectRevert("not authorized"); ws.rejectMany(ids);
        vm.prank(OWNER); ws.rejectMany(ids);
        require(ws.reserved(address(usdc)) == 0, "still reserved");
        vm.prank(OWNER); ws.withdraw(address(usdc), OWNER, 100e6);
    }
    function testOutcomeTotalsCannotBeRewritten() public {
        vm.prank(AGENT); ledger.recordOutcomes(address(ws), EXPERIMENT, GrowthLedger.Totals(10, 5, 2, 100e6, 0), keccak256("e"));
        vm.prank(AGENT); vm.expectRevert("totals cannot fall"); ledger.recordOutcomes(address(ws), EXPERIMENT, GrowthLedger.Totals(9, 5, 2, 100e6, 0), keccak256("e"));
        vm.prank(AGENT); vm.expectRevert("inconsistent outcomes"); ledger.recordOutcomes(address(ws), EXPERIMENT, GrowthLedger.Totals(10, 11, 2, 100e6, 0), keccak256("e"));
        vm.prank(AGENT); ledger.recordOutcomes(address(ws), EXPERIMENT, GrowthLedger.Totals(12, 6, 3, 120e6, 20e6), keccak256("e2"));
    }
}
