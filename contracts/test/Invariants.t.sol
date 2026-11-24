// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {GrowthFactory} from "../src/protocol/GrowthFactory.sol";
import {GrowthWorkspace} from "../src/protocol/GrowthWorkspace.sol";
import {OutcomeRewardsEscrow} from "../src/OutcomeRewardsEscrow.sol";

interface InvVm { function warp(uint256) external; function prank(address) external; }

contract InvToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address a, uint256 n) external { balanceOf[a] += n; }
    function approve(address a, uint256 n) external returns (bool) { allowance[msg.sender][a] = n; return true; }
    function transfer(address a, uint256 n) external returns (bool) { require(balanceOf[msg.sender] >= n, "balance"); balanceOf[msg.sender] -= n; balanceOf[a] += n; return true; }
    function transferFrom(address a, address b, uint256 n) external returns (bool) { require(balanceOf[a] >= n && allowance[a][msg.sender] >= n, "allowance"); allowance[a][msg.sender] -= n; balanceOf[a] -= n; balanceOf[b] += n; return true; }
}

/// Behaves like a filler: pulls up to its allowance of the sold token and pays out any amount of the bought token.
contract InvReactor {
    function fill(InvToken sell, InvToken buy, uint256 sold, uint256 bought) external {
        sell.transferFrom(msg.sender, address(this), sold);
        buy.mint(msg.sender, bought);
    }
}

abstract contract Bounded {
    InvVm internal constant vm = InvVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    struct FuzzSelector { address addr; bytes4[] selectors; }
    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) { return lo + x % (hi - lo + 1); }
    function _only(address target, bytes4[] memory selectors) internal pure returns (FuzzSelector[] memory targets) {
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(target, selectors);
    }
}

/// Random actions by every party, with the agent acting as if its key were stolen.
contract WorkspaceHandler is Bounded {
    address public constant OWNER = address(0xA11CE);
    address public constant AGENT = address(0xA6E7);
    address public constant APPROVER = address(0xB0B);
    address public constant SERVICE = address(0x5E4);
    address public constant STRANGER = address(0xBAD);
    GrowthWorkspace public immutable ws;
    InvToken public immutable usdc;
    InvToken public immutable usdt;
    InvToken public immutable cngn;
    InvReactor public immutable reactor;
    bytes32[2] public missions;
    bytes32[] public experiments;
    bytes32[] public intents;
    bytes32[] public corridorIntents;
    address[3] public creators = [address(0xC1), address(0xC2), address(0xC3)];
    bool public exitFailed;
    mapping(string => uint256) public hits;
    bool public corridorBroken;
    uint256 private n;

    constructor(GrowthWorkspace ws_, InvToken usdc_, InvToken usdt_, InvToken cngn_, InvReactor reactor_, bytes32[2] memory missions_) {
        ws = ws_; usdc = usdc_; usdt = usdt_; cngn = cngn_; reactor = reactor_; missions = missions_;
    }
    function experimentCount() external view returns (uint256) { return experiments.length; }
    function intentCount() external view returns (uint256) { return intents.length; }
    function creator(uint256 i) external view returns (address) { return creators[i]; }

    function _intent(uint256 seed) private view returns (bytes32) { return intents[seed % intents.length]; }

    function openExperiment(uint256 seed, uint256 budget, bool asOwner) external {
        bytes32 id = keccak256(abi.encode("experiment", ++n));
        vm.prank(asOwner ? OWNER : AGENT);
        try ws.openExperiment(id, missions[seed % 2], uint64(bound(budget, 1, 40e6)), keccak256("terms")) { experiments.push(id); hits["openExperiment"]++; } catch {}
    }
    function propose(uint256 seed, uint256 amount, uint8 category, uint8 mode, uint256 life) external {
        if (experiments.length == 0) return;
        bytes32 experiment = experiments[seed % experiments.length];
        (bytes32 mission,,,,) = ws.experiments(experiment);
        mode %= 4; // 0 USDC payment, 1 corridor payment, 2 USDC service, 3 USD₮ service outside any experiment
        uint64 value = uint64(bound(amount, 1, 25e6));
        GrowthWorkspace.IntentRequest memory r = GrowthWorkspace.IntentRequest({
            id: keccak256(abi.encode("intent", ++n)),
            missionId: mode == 3 ? missions[seed % 2] : mission,
            experimentId: mode == 3 ? bytes32(0) : experiment,
            recipient: mode >= 2 ? SERVICE : creators[seed % 3],
            token: mode == 1 || mode == 3 ? address(usdt) : address(usdc),
            payoutToken: mode == 1 ? address(cngn) : address(0),
            amount: value,
            expiresAt: uint64(block.timestamp + bound(life, 1 hours, 30 days)),
            category: uint8(category % 7),
            kind: mode >= 2 ? GrowthWorkspace.Kind.Service : GrowthWorkspace.Kind.Payment,
            minPayout: mode == 1 ? uint256(value) * 1000 : 0,
            evidenceHash: keccak256("evidence")
        });
        vm.prank(AGENT);
        try ws.propose(r) { intents.push(r.id); if (mode == 1) corridorIntents.push(r.id); hits[mode == 1 ? "proposeCorridor" : r.kind == GrowthWorkspace.Kind.Service ? "proposeService" : "proposePayment"]++; } catch {}
    }
    function approve(uint256 seed, uint8 who) external {
        if (intents.length == 0) return;
        address[3] memory actors = [OWNER, APPROVER, AGENT];
        vm.prank(actors[who % 3]);
        try ws.approve(_intent(seed)) { hits["approve"]++; } catch {}
    }
    function reject(uint256 seed) external {
        if (intents.length == 0) return;
        vm.prank(APPROVER);
        try ws.reject(_intent(seed)) { hits["reject"]++; } catch {}
    }
    function rejectMany(uint256 a, uint256 b, uint256 c) external {
        if (intents.length == 0) return;
        bytes32[] memory ids = new bytes32[](3);
        ids[0] = _intent(a); ids[1] = _intent(b); ids[2] = _intent(c);
        vm.prank(OWNER);
        try ws.rejectMany(ids) { hits["rejectMany"]++; } catch {}
    }
    function cancelExpired(uint256 seed) external {
        if (intents.length == 0) return;
        vm.prank(STRANGER);
        try ws.cancelExpired(_intent(seed)) { hits["cancelExpired"]++; } catch {}
    }
    function execute(uint256 seed) external {
        if (intents.length == 0) return;
        vm.prank(AGENT);
        try ws.execute(_intent(seed)) { hits["execute"]++; } catch {}
    }
    /// Tries an honest fill, one that takes more USD₮ than approved, or one that delivers below the minimum.
    function executeCorridor(uint256 seed, uint8 style, uint256 extra) external {
        if (corridorIntents.length == 0) return;
        bytes32 id = corridorIntents[seed % corridorIntents.length];
        GrowthWorkspace.Intent memory i = ws.intentOf(id);
        if (i.minPayout == 0) return;
        uint256 sold = bound(extra, 0, i.amount);
        uint256 bought = i.minPayout + bound(extra, 0, i.minPayout);
        if (style % 3 == 1) sold = uint256(i.amount) + bound(extra, 1, 1e6);
        if (style % 3 == 2) bought = bound(extra, 0, i.minPayout - 1);
        uint256 soldBefore = usdt.balanceOf(address(ws));
        uint256 paidBefore = cngn.balanceOf(i.recipient);
        bytes memory swap = abi.encodeCall(InvReactor.fill, (usdt, cngn, sold, bought));
        vm.prank(AGENT);
        try ws.executeCorridor(id, swap) {
            hits["executeCorridor"]++;
            if (soldBefore - usdt.balanceOf(address(ws)) > i.amount || cngn.balanceOf(i.recipient) - paidBefore < i.minPayout) corridorBroken = true;
        } catch {}
    }
    function stopExperiment(uint256 seed) external {
        if (experiments.length == 0) return;
        vm.prank(OWNER);
        try ws.stopExperiment(experiments[seed % experiments.length]) { hits["stopExperiment"]++; } catch {}
    }
    function reallocate(uint256 a, uint256 b, uint256 amount, bool asOwner) external {
        if (experiments.length < 2) return;
        vm.prank(asOwner ? OWNER : AGENT);
        try ws.reallocate(experiments[a % experiments.length], experiments[b % experiments.length], uint64(bound(amount, 1, 20e6))) { hits["reallocate"]++; } catch {}
    }
    function setPolicy(bool autonomy, uint256 maxTx, uint256 daily, uint256 ceiling, uint8 autonomous, uint8 approval) external {
        vm.prank(OWNER);
        try ws.setPolicy(GrowthWorkspace.Policy(autonomy, uint64(bound(maxTx, 0, 20e6)), uint64(bound(daily, 0, 40e6)), uint64(bound(ceiling, 1, 30e6)), autonomous % 128, approval % 128)) {} catch {}
    }
    /// Freezes about a quarter of the time, so frozen and running states both get explored.
    function setFrozen(uint8 roll) external {
        vm.prank(OWNER);
        ws.setFrozen(roll % 4 == 0);
    }
    function updateMission(uint256 seed, uint256 budget, uint256 extend, bool active) external {
        bytes32 id = missions[seed % 2];
        (,,, uint64 endsAt,,) = ws.missions(id);
        vm.prank(OWNER);
        try ws.updateMission(id, uint64(bound(budget, 1, 120e6)), uint64(endsAt + bound(extend, 0, 10 days)), active) {} catch {}
    }
    function fund(bool tether, uint256 amount) external {
        (tether ? usdt : usdc).mint(address(ws), bound(amount, 0, 50e6));
    }
    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 3 days));
    }
    /// The owner can always take out everything not reserved for an open payment, frozen or not.
    function ownerExit(bool tether) external {
        InvToken token = tether ? usdt : usdc;
        uint256 balance = token.balanceOf(address(ws));
        uint256 held = ws.reserved(address(token));
        if (balance <= held) return;
        vm.prank(OWNER);
        try ws.withdraw(address(token), OWNER, balance - held) { hits["ownerExit"]++; } catch { exitFailed = true; }
    }
}

contract GrowthWorkspaceInvariants is Bounded {
    WorkspaceHandler handler;
    GrowthWorkspace ws;
    InvToken usdc; InvToken usdt; InvToken cngn; InvReactor reactor;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new InvToken(); usdt = new InvToken(); cngn = new InvToken(); reactor = new InvReactor();
        address[] memory payouts = new address[](1); payouts[0] = address(cngn);
        GrowthFactory factory = new GrowthFactory(address(usdc), address(usdt), address(reactor), payouts);
        address owner = address(0xA11CE);
        address agent = address(0xA6E7);
        vm.prank(owner);
        ws = GrowthWorkspace(factory.createWorkspace(keccak256("ref"), agent, GrowthWorkspace.Policy(true, 5e6, 10e6, 20e6, 3, 124)));
        bytes32[2] memory missions = [keccak256("mission-a"), keccak256("mission-b")];
        uint8[] memory cats = new uint8[](3); cats[0] = 0; cats[1] = 1; cats[2] = 2;
        uint64[] memory budgets = new uint64[](3); budgets[0] = 20e6; budgets[1] = 20e6; budgets[2] = 40e6;
        for (uint256 i; i < 2; i++) {
            vm.prank(owner);
            ws.openMission(missions[i], 80e6, uint64(block.timestamp + 20 days), keccak256("goal"), cats, budgets);
        }
        handler = new WorkspaceHandler(ws, usdc, usdt, cngn, reactor, missions);
        address approver = handler.APPROVER();
        address service = handler.SERVICE();
        vm.prank(owner); ws.setRole(approver, 2);
        vm.prank(owner); ws.setService(service, true);
        for (uint256 i; i < 3; i++) {
            address payee = handler.creator(i);
            vm.prank(agent); ws.registerPayee(payee);
        }
        usdc.mint(address(ws), 100e6); usdt.mint(address(ws), 100e6);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    /// Only state-changing actions, so random sequences reach deep states instead of calling getters.
    function targetSelectors() public view returns (FuzzSelector[] memory) {
        WorkspaceHandler h = handler;
        bytes4[] memory s = new bytes4[](16);
        s[0] = h.openExperiment.selector; s[1] = h.propose.selector; s[2] = h.approve.selector; s[3] = h.reject.selector;
        s[4] = h.rejectMany.selector; s[5] = h.cancelExpired.selector; s[6] = h.execute.selector; s[7] = h.executeCorridor.selector;
        s[8] = h.stopExperiment.selector; s[9] = h.reallocate.selector; s[10] = h.setPolicy.selector; s[11] = h.setFrozen.selector;
        s[12] = h.updateMission.selector; s[13] = h.fund.selector; s[14] = h.warp.selector; s[15] = h.ownerExit.selector;
        return _only(address(h), s);
    }

    function _open(GrowthWorkspace.State s) private pure returns (bool) { return s == GrowthWorkspace.State.Pending || s == GrowthWorkspace.State.Approved; }

    /// Reserved funds always equal the open payments in that token.
    function invariant_reservedMatchesOpenPayments() public view {
        uint256 openUsdc; uint256 openUsdt;
        for (uint256 k; k < handler.intentCount(); k++) {
            GrowthWorkspace.Intent memory i = ws.intentOf(handler.intents(k));
            if (!_open(i.state)) continue;
            if (i.token == address(usdc)) openUsdc += i.amount; else openUsdt += i.amount;
        }
        require(ws.reserved(address(usdc)) == openUsdc && ws.reserved(address(usdt)) == openUsdt, "reserved drifted from open payments");
    }

    /// Budgets are never exceeded, and every commitment is accounted for exactly once.
    function invariant_budgetsAreConsistent() public view {
        for (uint256 m; m < 2; m++) {
            bytes32 mission = handler.missions(m);
            (uint64 budget, uint64 committed, uint64 allocated,,,) = ws.missions(mission);
            uint256 spent; uint256 experimentBudgets;
            for (uint256 k; k < handler.intentCount(); k++) {
                GrowthWorkspace.Intent memory i = ws.intentOf(handler.intents(k));
                if (i.missionId == mission && (i.state == GrowthWorkspace.State.Executed || _open(i.state))) spent += i.amount;
            }
            for (uint256 e; e < handler.experimentCount(); e++) {
                (bytes32 owner, uint64 eBudget,,,) = ws.experiments(handler.experiments(e));
                if (owner == mission) experimentBudgets += eBudget;
            }
            require(committed <= budget && allocated <= budget, "mission over budget");
            require(committed == spent, "mission commitment drifted");
            require(allocated == experimentBudgets, "mission allocation drifted");
        }
        for (uint256 e; e < handler.experimentCount(); e++) {
            bytes32 experiment = handler.experiments(e);
            (, uint64 eBudget, uint64 eCommitted,,) = ws.experiments(experiment);
            uint256 spent;
            for (uint256 k; k < handler.intentCount(); k++) {
                GrowthWorkspace.Intent memory i = ws.intentOf(handler.intents(k));
                if (i.experimentId == experiment && (i.state == GrowthWorkspace.State.Executed || _open(i.state))) spent += i.amount;
            }
            require(eCommitted <= eBudget, "experiment over budget");
            require(eCommitted == spent, "experiment commitment drifted");
        }
    }

    /// No payment to a person is executed without someone other than the agent approving it,
    /// and anything that ran without approval went to an approved service.
    function invariant_executedPaymentsWereAuthorized() public view {
        for (uint256 k; k < handler.intentCount(); k++) {
            GrowthWorkspace.Intent memory i = ws.intentOf(handler.intents(k));
            if (i.state != GrowthWorkspace.State.Executed) continue;
            if (i.kind == GrowthWorkspace.Kind.Payment) require(i.humanRequired, "payment skipped approval");
            if (i.humanRequired) require(i.approver != address(0) && i.approver != i.proposer, "unapproved execution");
            else require(i.recipient == handler.SERVICE(), "autonomous payment to unapproved recipient");
        }
    }

    function invariant_agentNeverReceivesFunds() public view {
        address agent = handler.AGENT();
        require(usdc.balanceOf(agent) == 0 && usdt.balanceOf(agent) == 0 && cngn.balanceOf(agent) == 0, "agent received funds");
    }

    function invariant_noStandingAllowanceOrCorridorLeak() public view {
        require(usdt.allowance(address(ws), address(reactor)) == 0, "reactor allowance left open");
        require(!handler.corridorBroken(), "corridor overspent or underdelivered");
    }

    function invariant_ownerCanAlwaysExit() public view {
        require(!handler.exitFailed(), "owner could not withdraw unreserved funds");
    }
}

/// Random campaigns, rewards, disputes and claims across several funders.
contract EscrowHandler is Bounded {
    address public constant ARBITER = address(0xBEEF);
    OutcomeRewardsEscrow public immutable escrow;
    InvToken public immutable token;
    address[3] public funders = [address(0xF1), address(0xF2), address(0xF3)];
    address[4] public recipients = [address(0xD1), address(0xD2), address(0xD3), address(0xD4)];
    bytes32[] public campaigns;
    bytes32[] public rewardCampaign;
    bytes32[] public rewardIds;
    mapping(bytes32 => uint256) public timesPaid;
    uint256 public totalPaid;
    bool public doublePaid;
    mapping(string => uint256) public hits;
    uint256 private n;

    constructor(OutcomeRewardsEscrow escrow_, InvToken token_) { escrow = escrow_; token = token_; }
    function campaignCount() external view returns (uint256) { return campaigns.length; }
    function rewardCount() external view returns (uint256) { return rewardIds.length; }

    function create(uint256 who, uint256 base, uint256 quality, uint256 outcome, uint256 cap, uint256 slots, uint256 extra) external {
        address funder = funders[who % 3];
        uint256 b = bound(base, 1, 5e6);
        uint256 q = bound(quality, 0, 5e6);
        uint256 o = bound(outcome, 0, 1e6);
        uint256 c = bound(cap, 0, 5);
        uint256 s = bound(slots, 1, 5);
        uint256 budget = (b + q + o * c) * s + bound(extra, 0, 10e6);
        bytes32 salt = keccak256(abi.encode("salt", ++n));
        token.mint(funder, budget);
        vm.prank(funder); token.approve(address(escrow), budget);
        vm.prank(funder);
        try escrow.createCampaign(salt, ARBITER, block.timestamp + 1 days, budget, b, q, o, c, s, keccak256("terms")) { campaigns.push(escrow.campaignKey(funder, salt)); hits["create"]++; } catch {}
    }
    function queue(uint256 seed, uint256 who, uint256 quality, uint256 outcomes) external {
        if (campaigns.length == 0) return;
        bytes32 c = campaigns[seed % campaigns.length];
        (address owner,,,,,,,,,,,) = escrow.campaigns(c);
        bytes32 rewardId = keccak256(abi.encode("reward", ++n));
        vm.prank(owner);
        try escrow.queueReward(c, rewardId, recipients[who % 4], bound(quality, 0, 100), bound(outcomes, 0, 5), keccak256("evidence")) { rewardCampaign.push(c); rewardIds.push(rewardId); hits["queue"]++; } catch {}
    }
    function reduce(uint256 seed, uint256 outcomes) external {
        if (rewardIds.length == 0) return;
        uint256 k = seed % rewardIds.length;
        (address owner,,,,,,,,,,,) = escrow.campaigns(rewardCampaign[k]);
        vm.prank(owner);
        try escrow.reduceOutcomes(rewardCampaign[k], rewardIds[k], bound(outcomes, 0, 5), keccak256("refund")) { hits["reduce"]++; } catch {}
    }
    function dispute(uint256 seed, bool byOwner) external {
        if (rewardIds.length == 0) return;
        uint256 k = seed % rewardIds.length;
        (address owner,,,,,,,,,,,) = escrow.campaigns(rewardCampaign[k]);
        (address recipient,,,,,,,) = escrow.rewards(rewardCampaign[k], rewardIds[k]);
        vm.prank(byOwner ? owner : recipient);
        try escrow.dispute(rewardCampaign[k], rewardIds[k]) { hits["dispute"]++; } catch {}
    }
    function resolve(uint256 seed, bool release) external {
        if (rewardIds.length == 0) return;
        uint256 k = seed % rewardIds.length;
        vm.prank(ARBITER);
        try escrow.resolve(rewardCampaign[k], rewardIds[k], release) { hits[release ? "release" : "rejectReward"]++; } catch {}
    }
    function claim(uint256 seed) external {
        if (rewardIds.length == 0) return;
        uint256 k = seed % rewardIds.length;
        (address recipient, uint256 amount,,,,,,) = escrow.rewards(rewardCampaign[k], rewardIds[k]);
        uint256 before = token.balanceOf(recipient);
        try escrow.claim(rewardCampaign[k], rewardIds[k]) {
            if (++timesPaid[rewardIds[k]] > 1 || token.balanceOf(recipient) - before != amount) doublePaid = true;
            totalPaid += amount;
            hits["claim"]++;
        } catch {}
    }
    function refund(uint256 seed) external {
        if (campaigns.length == 0) return;
        bytes32 c = campaigns[seed % campaigns.length];
        (address owner,,,,,,,,,,,) = escrow.campaigns(c);
        vm.prank(owner);
        try escrow.refundUnused(c) { hits["refund"]++; } catch {}
    }
    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 4 days));
    }
}

contract OutcomeRewardsEscrowInvariants is Bounded {
    EscrowHandler handler;
    OutcomeRewardsEscrow escrow;
    InvToken token;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new InvToken();
        escrow = new OutcomeRewardsEscrow(address(token), 2 days);
        handler = new EscrowHandler(escrow, token);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory) {
        EscrowHandler h = handler;
        bytes4[] memory s = new bytes4[](8);
        s[0] = h.create.selector; s[1] = h.queue.selector; s[2] = h.reduce.selector; s[3] = h.dispute.selector;
        s[4] = h.resolve.selector; s[5] = h.claim.selector; s[6] = h.refund.selector; s[7] = h.warp.selector;
        return _only(address(h), s);
    }

    /// Every token the escrow holds is either available to its funder or reserved for a reward.
    function invariant_balanceMatchesCampaigns() public view {
        uint256 total;
        for (uint256 k; k < handler.campaignCount(); k++) {
            (,,, uint256 available, uint256 reserved,,,,, uint256 slots, uint256 queued,) = escrow.campaigns(handler.campaigns(k));
            require(queued <= slots, "more rewards than slots");
            total += available + reserved;
        }
        require(token.balanceOf(address(escrow)) == total, "escrow balance drifted from campaigns");
    }

    function invariant_eachRewardPaidOnceAndExactly() public view {
        require(!handler.doublePaid(), "reward paid twice or wrong amount");
    }
}
