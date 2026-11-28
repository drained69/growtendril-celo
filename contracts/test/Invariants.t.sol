// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {GrowthFactory} from "../src/protocol/GrowthFactory.sol";
import {GrowthWorkspace} from "../src/protocol/GrowthWorkspace.sol";
import {GrowthLedger} from "../src/protocol/GrowthLedger.sol";
import {OutcomeRewardsEscrow} from "../src/OutcomeRewardsEscrow.sol";
import {CampaignEscrow} from "../src/CampaignEscrow.sol";

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
        // 0 USDC payment, 1 corridor payment, 2 USDC service, 3 USD₮ service outside any experiment,
        // 4 corridor dressed up as a service with a near-zero minimum (what a stolen agent key would try)
        mode %= 5;
        bool corridor = mode == 1 || mode == 4;
        uint64 value = uint64(bound(amount, 1, 25e6));
        GrowthWorkspace.IntentRequest memory r = GrowthWorkspace.IntentRequest({
            id: keccak256(abi.encode("intent", ++n)),
            missionId: mode == 3 ? missions[seed % 2] : mission,
            experimentId: mode == 3 ? bytes32(0) : experiment,
            recipient: mode >= 2 ? SERVICE : creators[seed % 3],
            token: corridor || mode == 3 ? address(usdt) : address(usdc),
            payoutToken: corridor ? address(cngn) : address(0),
            amount: value,
            expiresAt: uint64(block.timestamp + bound(life, 1 hours, 30 days)),
            category: uint8(category % 7),
            kind: mode >= 2 ? GrowthWorkspace.Kind.Service : GrowthWorkspace.Kind.Payment,
            minPayout: mode == 1 ? uint256(value) * 1000 : mode == 4 ? 1 : 0,
            evidenceHash: keccak256("evidence")
        });
        vm.prank(AGENT);
        try ws.propose(r) { intents.push(r.id); if (corridor) corridorIntents.push(r.id); hits[corridor ? "proposeCorridor" : r.kind == GrowthWorkspace.Kind.Service ? "proposeService" : "proposePayment"]++; } catch {}
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
            else require(i.recipient == handler.SERVICE() && i.payoutToken == address(0), "autonomous payment to unapproved recipient or conversion");
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

/// Random ledger writes by the owner, the agent, a stranger, and an agent the owner has removed.
contract LedgerHandler is Bounded {
    address public constant OWNER = address(0xA11CE);
    address public constant AGENT = address(0xA6E7);
    address public constant STRANGER = address(0xBAD);
    GrowthWorkspace public immutable ws;
    GrowthLedger public immutable ledger;
    bytes32 public expectedHead;
    uint64 public expectedCount;
    bool public agentActive = true;
    bool public unauthorizedWrite;
    bool public totalsFell;

    constructor(GrowthWorkspace ws_, GrowthLedger ledger_) { ws = ws_; ledger = ledger_; }

    function _writer(uint8 who) private view returns (address w, bool allowed) {
        who %= 3;
        w = who == 0 ? OWNER : who == 1 ? AGENT : STRANGER;
        allowed = who == 0 || (who == 1 && agentActive);
    }
    function commit(uint8 who, bytes32 root, uint32 records, bool stale) external {
        (address w, bool allowed) = _writer(who);
        bytes32 head = stale ? keccak256(abi.encode(root)) : expectedHead;
        vm.prank(w);
        try ledger.commitCheckpoint(address(ws), root, records, head) returns (uint64 number) {
            if (!allowed) unauthorizedWrite = true;
            expectedCount++;
            expectedHead = keccak256(abi.encode(expectedHead, address(ws), number, root, records));
        } catch {}
    }
    function record(uint8 who, uint8 experiment, uint256 seed) external {
        (address w, bool allowed) = _writer(who);
        bytes32 id = keccak256(abi.encode("experiment", experiment % 3));
        uint64 customers = uint64(seed % 1000);
        uint64 revenue = uint64((seed >> 48) % 1e9);
        GrowthLedger.Totals memory t = GrowthLedger.Totals(customers, customers * uint64((seed >> 16) % 101) / 100, customers * uint64((seed >> 32) % 101) / 100, revenue, revenue * uint64((seed >> 96) % 101) / 100);
        bool fell = _below(id, t);
        vm.prank(w);
        try ledger.recordOutcomes(address(ws), id, t, keccak256("evidence")) {
            if (!allowed) unauthorizedWrite = true;
            if (fell) totalsFell = true;
        } catch {}
    }
    function _below(bytes32 id, GrowthLedger.Totals memory t) private view returns (bool) {
        (uint64 c, uint64 a, uint64 p, uint64 r, uint64 f,,) = ledger.outcomes(address(ws), id);
        return t.customers < c || t.activated < a || t.paying < p || t.revenue < r || t.refunded < f;
    }
    function setAgent(bool active) external {
        vm.prank(OWNER);
        ws.setRole(AGENT, active ? 4 : 0);
        agentActive = active;
    }
}

contract GrowthLedgerInvariants is Bounded {
    LedgerHandler handler;
    GrowthLedger ledger;
    GrowthWorkspace ws;

    function setUp() public {
        vm.warp(1_800_000_000);
        InvToken usdc = new InvToken();
        InvToken usdt = new InvToken();
        InvReactor reactor = new InvReactor();
        GrowthFactory factory = new GrowthFactory(address(usdc), address(usdt), address(reactor), new address[](0));
        ledger = new GrowthLedger(address(factory));
        vm.prank(address(0xA11CE));
        ws = GrowthWorkspace(factory.createWorkspace(keccak256("ref"), address(0xA6E7), GrowthWorkspace.Policy(false, 0, 0, 1, 0, 127)));
        handler = new LedgerHandler(ws, ledger);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }
    function targetSelectors() public view returns (FuzzSelector[] memory) {
        LedgerHandler h = handler;
        bytes4[] memory s = new bytes4[](3);
        s[0] = h.commit.selector; s[1] = h.record.selector; s[2] = h.setAgent.selector;
        return _only(address(h), s);
    }

    /// Every checkpoint extends the hash chain; none can be skipped, forked or rewritten.
    function invariant_hashChainIsIntact() public view {
        require(ledger.head(address(ws)) == handler.expectedHead() && ledger.checkpointCount(address(ws)) == handler.expectedCount(), "ledger chain forked or rewritten");
    }
    function invariant_onlyCurrentWritersWrite() public view {
        require(!handler.unauthorizedWrite(), "stranger or removed agent wrote to the ledger");
    }
    function invariant_outcomeTotalsNeverFall() public view {
        require(!handler.totalsFell(), "outcome totals fell");
    }
}

/// Random actions on open-campaign escrow by owners, their current agents, removed agents and strangers.
contract CampaignEscrowHandler is Bounded {
    CampaignEscrow public immutable escrow;
    InvToken public immutable token;
    address public constant STRANGER = address(0x5757);
    address[3] public funders = [address(0xF1), address(0xF2), address(0xF3)];
    address[3] public agents = [address(0xA1), address(0xA2), address(0xA3)];
    address[4] public recipients = [address(0xD1), address(0xD2), address(0xD3), address(0xD4)];
    bytes32[] public campaigns;
    bytes32[] public rewardCampaign;
    bytes32[] public rewardIds;
    mapping(bytes32 => uint256) public timesPaid;
    mapping(bytes32 => uint256) public maxPerReward;
    bool public doublePaid;
    bool public objectedPaid;
    bool public unauthorizedQueue;
    bool public overTerms;
    bool public badTiming;
    mapping(string => uint256) public hits;
    uint256 private n;

    struct Terms { uint256 b; uint256 q; uint256 o; uint256 c; uint256 s; uint256 budget; uint256 deadline; address agent; }

    constructor(CampaignEscrow escrow_, InvToken token_) { escrow = escrow_; token = token_; }
    function campaignCount() external view returns (uint256) { return campaigns.length; }
    function rewardCount() external view returns (uint256) { return rewardIds.length; }

    function create(uint256 who, uint256 seed, uint256 base, uint256 quality, uint256 outcome) external {
        Terms memory t;
        t.b = bound(base, 1, 5e6);
        t.q = bound(quality, 0, 5e6);
        t.o = bound(outcome, 0, 1e6);
        uint256 r = uint256(keccak256(abi.encode(seed)));
        t.c = bound(r & 0xff, 0, 5);
        t.s = bound((r >> 8) & 0xff, 1, 5);
        t.budget = (t.b + t.q + t.o * t.c) * t.s + bound((r >> 16) & 0xffffffff, 0, 10e6);
        t.deadline = block.timestamp + bound((r >> 64) & 0xff, 1, 5) * 1 days;
        t.agent = (r >> 96) % 4 == 3 ? address(0) : agents[(r >> 96) % 3];
        _create(funders[who % 3], t);
    }
    function _create(address funder, Terms memory t) private {
        bytes32 salt = keccak256(abi.encode("salt", ++n));
        token.mint(funder, t.budget);
        vm.prank(funder); token.approve(address(escrow), t.budget);
        vm.prank(funder);
        try escrow.createCampaign(salt, t.agent, t.deadline, t.budget, t.b, t.q, t.o, t.c, t.s, keccak256("terms")) {
            bytes32 id = escrow.campaignKey(funder, salt);
            campaigns.push(id);
            maxPerReward[id] = t.b + t.q + t.o * t.c;
            hits["create"]++;
        } catch {}
    }
    function setAgent(uint256 seed, uint256 agentSeed) external {
        if (campaigns.length == 0) return;
        bytes32 c = campaigns[seed % campaigns.length];
        vm.prank(_owner(c));
        try escrow.setAgent(c, agentSeed % 4 == 3 ? address(0) : agents[agentSeed % 3]) { hits["setAgent"]++; } catch {}
    }
    function _owner(bytes32 c) private view returns (address owner) { (owner,,,,,,,,,,,) = escrow.campaigns(c); }
    function _agent(bytes32 c) private view returns (address agent) { (, agent,,,,,,,,,,) = escrow.campaigns(c); }
    /// actor 0 = owner, 1 = current agent, 2 = some other agent (possibly removed), 3 = stranger.
    function _sender(bytes32 c, uint256 actor, uint256 seed) private view returns (address) {
        uint256 a = actor % 4;
        return a == 0 ? _owner(c) : a == 1 ? _agent(c) : a == 2 ? agents[seed % 3] : STRANGER;
    }
    function queue(uint256 seed, uint256 actor, uint256 who, uint256 quality, uint256 outcomes) external {
        if (campaigns.length == 0) return;
        bytes32 c = campaigns[seed % campaigns.length];
        address sender = _sender(c, actor, seed);
        address recipient = recipients[who % 4];
        bool allowed = sender == _owner(c) || (sender == _agent(c) && sender != address(0) && !escrow.objectedTo(c, recipient));
        bytes32 rewardId = keccak256(abi.encode("reward", ++n));
        vm.prank(sender);
        try escrow.queueReward(c, rewardId, recipient, bound(quality, 0, 100), bound(outcomes, 0, 5), keccak256("evidence")) {
            if (!allowed) unauthorizedQueue = true;
            (, uint256 amount,,,,,) = escrow.rewards(c, rewardId);
            if (amount > maxPerReward[c]) overTerms = true;
            rewardCampaign.push(c); rewardIds.push(rewardId);
            hits["queue"]++;
        } catch {}
    }
    /// actor 0 = owner, 1 = agent, 2 = recipient, 3 = stranger.
    function object(uint256 seed, uint256 actor) external {
        if (rewardIds.length == 0) return;
        uint256 k = seed % rewardIds.length;
        bytes32 c = rewardCampaign[k];
        (address recipient,,,, uint256 claimableAt,,) = escrow.rewards(c, rewardIds[k]);
        uint256 a = actor % 4;
        address sender = a == 0 ? _owner(c) : a == 1 ? _agent(c) : a == 2 ? recipient : STRANGER;
        vm.prank(sender);
        try escrow.object(c, rewardIds[k], keccak256("reason")) {
            if (sender != _owner(c) || block.timestamp >= claimableAt) badTiming = true;
            hits["object"]++;
        } catch {}
    }
    function claim(uint256 seed) external {
        if (rewardIds.length == 0) return;
        uint256 k = seed % rewardIds.length;
        (address recipient, uint256 amount,,, uint256 claimableAt,, CampaignEscrow.Status before) = escrow.rewards(rewardCampaign[k], rewardIds[k]);
        uint256 balance = token.balanceOf(recipient);
        vm.prank(STRANGER);
        try escrow.claim(rewardCampaign[k], rewardIds[k]) {
            if (++timesPaid[rewardIds[k]] > 1 || token.balanceOf(recipient) - balance != amount) doublePaid = true;
            if (before == CampaignEscrow.Status.Objected) objectedPaid = true;
            if (block.timestamp < claimableAt) badTiming = true;
            hits["claim"]++;
        } catch {}
    }
    function refund(uint256 seed) external {
        if (campaigns.length == 0) return;
        bytes32 c = campaigns[seed % campaigns.length];
        vm.prank(_owner(c));
        try escrow.refundUnused(c) { hits["refund"]++; } catch {}
    }
    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 4 days));
    }
}

contract CampaignEscrowInvariants is Bounded {
    CampaignEscrowHandler handler;
    CampaignEscrow escrow;
    InvToken token;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new InvToken();
        escrow = new CampaignEscrow(address(token), 2 days);
        handler = new CampaignEscrowHandler(escrow, token);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory) {
        CampaignEscrowHandler h = handler;
        bytes4[] memory s = new bytes4[](7);
        s[0] = h.create.selector; s[1] = h.setAgent.selector; s[2] = h.queue.selector; s[3] = h.object.selector;
        s[4] = h.claim.selector; s[5] = h.refund.selector; s[6] = h.warp.selector;
        return _only(address(h), s);
    }

    /// Every token the escrow holds is either available to its funder or reserved for a waiting reward.
    function invariant_balanceMatchesCampaigns() public view {
        uint256 total;
        for (uint256 k; k < handler.campaignCount(); k++) {
            (,,, uint256 available, uint256 reserved,,,,, uint256 slots, uint256 queued,) = escrow.campaigns(handler.campaigns(k));
            require(queued <= slots, "more rewards than slots");
            total += available + reserved;
        }
        require(token.balanceOf(address(escrow)) == total, "escrow balance drifted from campaigns");
    }

    /// Each campaign's reserved money equals its waiting rewards, its count equals waiting plus paid rewards,
    /// and no recipient holds more than one waiting or paid reward in a campaign.
    function invariant_accountingMatchesRewards() public view {
        for (uint256 k; k < handler.campaignCount(); k++) _checkCampaign(handler.campaigns(k));
    }
    function _checkCampaign(bytes32 c) private view {
        uint256 held; uint256 live;
        uint256[4] memory perRecipient;
        for (uint256 j; j < handler.rewardCount(); j++) {
            if (handler.rewardCampaign(j) != c) continue;
            (uint256 amount, uint256 r, CampaignEscrow.Status s) = _reward(c, handler.rewardIds(j));
            if (s == CampaignEscrow.Status.Held) held += amount;
            if (s == CampaignEscrow.Status.Held || s == CampaignEscrow.Status.Paid) { live++; perRecipient[r]++; }
        }
        (,,,, uint256 reserved,,,,,, uint256 queued,) = escrow.campaigns(c);
        require(reserved == held, "reserved money differs from waiting rewards");
        require(queued == live, "reward count differs from waiting and paid rewards");
        for (uint256 r; r < 4; r++) require(perRecipient[r] <= 1, "recipient rewarded twice");
    }
    function _reward(bytes32 c, bytes32 id) private view returns (uint256 amount, uint256 index, CampaignEscrow.Status s) {
        address recipient;
        (recipient, amount,,,,, s) = escrow.rewards(c, id);
        for (uint256 r; r < 4; r++) if (recipient == handler.recipients(r)) index = r;
    }

    function invariant_paidOnceExactlyAndNeverAfterObjection() public view {
        require(!handler.doublePaid(), "reward paid twice or wrong amount");
        require(!handler.objectedPaid(), "objected reward paid");
    }

    function invariant_onlyOwnerOrCurrentAgentApproves() public view {
        require(!handler.unauthorizedQueue(), "stranger, removed agent or blocked recipient approved");
        require(!handler.overTerms(), "reward above the campaign terms");
    }

    function invariant_holdTimingIsEnforced() public view {
        require(!handler.badTiming(), "objection after the hold or payout before it");
    }
}
