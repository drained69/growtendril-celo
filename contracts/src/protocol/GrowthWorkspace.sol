// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

interface IGrowthToken {
    function balanceOf(address account) external view returns (uint256);
}
interface IGrowthFactory {
    function isPayoutToken(address token) external view returns (bool);
}

/// @notice One customer's growth treasury and the rules that govern it: team roles, spend policy,
///         missions, experiments, approvals, payouts and a kill switch.
/// @dev The agent is only an operator. It can propose and execute inside these rules, and cannot
///      withdraw, change policy, approve its own proposal or sign for this contract. No admin key,
///      upgrade path or ERC-1271 signing exists.
contract GrowthWorkspace {
    uint8 public constant ROLE_ADMIN = 1;
    uint8 public constant ROLE_APPROVER = 2;
    uint8 public constant ROLE_OPERATOR = 4;
    uint8 public constant CATEGORY_COUNT = 7; // research, services, kol, bounty, content, community, treasury
    uint64 public constant PAYEE_HOLD = 24 hours;
    uint64 public constant MAX_INTENT_LIFETIME = 30 days;

    enum Kind { Payment, Service }
    enum State { None, Pending, Approved, Executed, Rejected, Cancelled }

    struct Policy {
        bool autonomyEnabled;
        uint64 maxTransaction;
        uint64 dailySpend;
        uint64 hardCeiling;
        uint8 autonomousCategories;
        uint8 approvalCategories;
    }
    struct Mission { uint64 budget; uint64 committed; uint64 allocated; uint64 endsAt; bool active; bytes32 goalHash; }
    struct Experiment { bytes32 missionId; uint64 budget; uint64 committed; bool active; bytes32 termsHash; }
    struct Payee { address setBy; uint64 setAt; }
    struct IntentRequest {
        bytes32 id;
        bytes32 missionId;
        bytes32 experimentId;
        address recipient;
        address token;
        address payoutToken;
        uint64 amount;
        uint64 expiresAt;
        uint8 category;
        Kind kind;
        uint256 minPayout;
        bytes32 evidenceHash;
    }
    struct Intent {
        bytes32 missionId;
        bytes32 experimentId;
        address recipient;
        address token;
        address payoutToken;
        address proposer;
        address approver;
        uint64 amount;
        uint64 expiresAt;
        uint8 category;
        Kind kind;
        State state;
        bool humanRequired;
        uint256 minPayout;
        bytes32 evidenceHash;
    }

    address public immutable factory;
    address public immutable usdc;
    address public immutable usdt;
    address public immutable reactor;

    address public owner;
    address public pendingOwner;
    bytes32 public ref;
    bool public frozen;
    bool private entered;
    Policy public policy;
    uint64 public spendDay;
    uint64 public spentToday;

    mapping(address => uint8) public roles;
    mapping(bytes32 => Mission) public missions;
    mapping(bytes32 => mapping(uint8 => uint64)) public categoryBudget;
    mapping(bytes32 => mapping(uint8 => uint64)) public categoryCommitted;
    mapping(bytes32 => Experiment) public experiments;
    mapping(bytes32 => Intent) private intents;
    mapping(address => Payee) public payees;
    mapping(address => bool) public approvedServices;
    mapping(address => uint256) public reserved;

    event RoleSet(address indexed account, uint8 roles, address indexed by);
    event OwnershipOffered(address indexed to);
    event OwnershipAccepted(address indexed from, address indexed to);
    event PolicySet(Policy policy, address indexed by);
    event FrozenSet(bool frozen, address indexed by);
    event ServiceSet(address indexed service, bool approved);
    event PayeeRegistered(address indexed payee, address indexed by);
    event MissionOpened(bytes32 indexed id, uint64 budget, uint64 endsAt, bytes32 goalHash);
    event MissionUpdated(bytes32 indexed id, uint64 budget, uint64 endsAt, bool active);
    event ExperimentOpened(bytes32 indexed id, bytes32 indexed missionId, uint64 budget, bytes32 termsHash);
    event ExperimentStopped(bytes32 indexed id, uint64 released);
    event BudgetReallocated(bytes32 indexed from, bytes32 indexed to, uint64 amount, address indexed by);
    event IntentProposed(bytes32 indexed id, bytes32 indexed missionId, bytes32 indexed experimentId, address recipient, address token, uint64 amount, uint8 category, bool humanRequired, bytes32 evidenceHash);
    event IntentApproved(bytes32 indexed id, address indexed approver);
    event IntentClosed(bytes32 indexed id, State state, address indexed by);
    event IntentExecuted(bytes32 indexed id, address indexed recipient, address indexed token, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    modifier nonReentrant() { require(!entered, "reentrant"); entered = true; _; entered = false; }
    modifier onlyOwner() { require(msg.sender == owner, "owner only"); _; }
    modifier onlyRole(uint8 mask) { require(hasRole(msg.sender, mask), "not authorized"); _; }
    modifier notFrozen() { require(!frozen, "frozen"); _; }

    constructor(address factory_, address usdc_, address usdt_, address reactor_) {
        factory = factory_; usdc = usdc_; usdt = usdt_; reactor = reactor_;
    }

    function initialize(address owner_, bytes32 ref_, address operator, Policy calldata policy_) external {
        require(msg.sender == factory && owner == address(0), "already initialized");
        require(owner_ != address(0) && operator != address(0) && operator != owner_ && ref_ != bytes32(0), "invalid setup");
        owner = owner_; ref = ref_; roles[operator] = ROLE_OPERATOR;
        _setPolicy(policy_, owner_);
        emit RoleSet(operator, ROLE_OPERATOR, owner_);
    }

    function hasRole(address account, uint8 mask) public view returns (bool) {
        return account == owner || roles[account] & mask != 0;
    }

    // ── Team ──
    function setRole(address account, uint8 newRoles) external onlyRole(ROLE_ADMIN) {
        require(account != address(0) && account != owner && newRoles <= 7, "invalid role");
        if (msg.sender != owner) require(newRoles & ROLE_ADMIN == 0 && roles[account] & ROLE_ADMIN == 0, "owner manages admins");
        roles[account] = newRoles;
        emit RoleSet(account, newRoles, msg.sender);
    }
    function offerOwnership(address to) external onlyOwner { pendingOwner = to; emit OwnershipOffered(to); }
    function acceptOwnership() external {
        require(msg.sender == pendingOwner && msg.sender != address(0), "not offered");
        emit OwnershipAccepted(owner, msg.sender);
        owner = msg.sender; pendingOwner = address(0); roles[msg.sender] = 0;
    }

    // ── Policy and kill switch ──
    function setPolicy(Policy calldata next) external onlyRole(ROLE_ADMIN) { _setPolicy(next, msg.sender); }
    function _setPolicy(Policy calldata next, address by) private {
        uint8 all = uint8((1 << CATEGORY_COUNT) - 1);
        require(next.hardCeiling > 0 && next.autonomousCategories <= all && next.approvalCategories <= all, "invalid policy");
        policy = next;
        emit PolicySet(next, by);
    }
    function setFrozen(bool value) external onlyRole(value ? ROLE_ADMIN | ROLE_APPROVER : ROLE_ADMIN) {
        frozen = value;
        emit FrozenSet(value, msg.sender);
    }
    function setService(address service, bool approved) external onlyRole(ROLE_ADMIN) {
        require(service != address(0), "invalid service");
        approvedServices[service] = approved;
        emit ServiceSet(service, approved);
    }
    function registerPayee(address payee) external onlyRole(ROLE_ADMIN | ROLE_OPERATOR) {
        require(payee != address(0) && payee != address(this), "invalid payee");
        // An operator can add a new payee but cannot overwrite a record and clear someone's approval hold.
        require(payees[payee].setAt == 0 || hasRole(msg.sender, ROLE_ADMIN), "payee already registered");
        payees[payee] = Payee(msg.sender, uint64(block.timestamp));
        emit PayeeRegistered(payee, msg.sender);
    }

    // ── Missions and experiments ──
    function openMission(bytes32 id, uint64 budget, uint64 endsAt, bytes32 goalHash, uint8[] calldata categories, uint64[] calldata budgets) external onlyRole(ROLE_ADMIN) {
        require(id != bytes32(0) && missions[id].endsAt == 0 && budget > 0 && endsAt > block.timestamp && categories.length == budgets.length, "invalid mission");
        missions[id] = Mission(budget, 0, 0, endsAt, true, goalHash);
        for (uint256 i; i < categories.length; i++) {
            require(categories[i] < CATEGORY_COUNT, "invalid category");
            categoryBudget[id][categories[i]] = budgets[i];
        }
        emit MissionOpened(id, budget, endsAt, goalHash);
    }
    function updateMission(bytes32 id, uint64 budget, uint64 endsAt, bool active) external onlyRole(ROLE_ADMIN) {
        Mission storage m = missions[id];
        // endsAt marks a mission as existing. Clearing it would let openMission wipe live commitments.
        require(endsAt != 0, "invalid mission");
        require(m.endsAt != 0 && budget >= m.committed && budget >= m.allocated, "below commitments");
        m.budget = budget; m.endsAt = endsAt; m.active = active;
        emit MissionUpdated(id, budget, endsAt, active);
    }
    function openExperiment(bytes32 id, bytes32 missionId, uint64 budget, bytes32 termsHash) external onlyRole(ROLE_ADMIN | ROLE_OPERATOR) notFrozen {
        Mission storage m = missions[missionId];
        require(id != bytes32(0) && experiments[id].missionId == bytes32(0) && budget > 0, "invalid experiment");
        require(m.active && block.timestamp < m.endsAt && m.allocated + budget <= m.budget, "mission budget");
        m.allocated += budget;
        experiments[id] = Experiment(missionId, budget, 0, true, termsHash);
        emit ExperimentOpened(id, missionId, budget, termsHash);
    }
    function stopExperiment(bytes32 id) external onlyRole(ROLE_ADMIN) {
        Experiment storage e = experiments[id];
        require(e.active, "not active");
        uint64 released = e.budget - e.committed;
        e.active = false; e.budget = e.committed;
        missions[e.missionId].allocated -= released;
        emit ExperimentStopped(id, released);
    }
    /// @notice Move unspent budget toward a winning experiment. Large moves need an admin.
    function reallocate(bytes32 fromId, bytes32 toId, uint64 amount) external onlyRole(ROLE_ADMIN | ROLE_OPERATOR) notFrozen {
        if (!hasRole(msg.sender, ROLE_ADMIN)) require(policy.autonomyEnabled && amount <= policy.dailySpend, "admin required");
        Experiment storage from = experiments[fromId];
        Experiment storage to = experiments[toId];
        require(fromId != toId && amount > 0 && from.active && to.active && from.missionId == to.missionId, "invalid move");
        require(from.budget - from.committed >= amount, "source lacks budget");
        from.budget -= amount; to.budget += amount;
        emit BudgetReallocated(fromId, toId, amount, msg.sender);
    }

    // ── Payments ──
    /// @notice Reverting here is a DENY. A stored intent is either approved or waiting for a human.
    function propose(IntentRequest calldata r) external onlyRole(ROLE_OPERATOR) notFrozen nonReentrant returns (bool humanRequired) {
        require(r.id != bytes32(0) && intents[r.id].state == State.None, "intent exists");
        require(r.recipient != address(0) && r.recipient != address(this) && r.amount > 0 && r.expiresAt > block.timestamp && r.expiresAt <= block.timestamp + MAX_INTENT_LIFETIME, "invalid intent");
        require(r.token == usdc || r.token == usdt, "token not allowed");
        require(r.category < CATEGORY_COUNT && (policy.autonomousCategories | policy.approvalCategories) & (1 << r.category) != 0, "category not allowed");
        require(r.amount <= policy.hardCeiling, "hard ceiling");
        if (r.payoutToken == address(0)) require(r.minPayout == 0, "invalid payout");
        else require(r.token == usdt && r.minPayout > 0 && IGrowthFactory(factory).isPayoutToken(r.payoutToken), "invalid payout");
        if (r.kind == Kind.Payment) require(payees[r.recipient].setAt != 0 && r.experimentId != bytes32(0), "unknown payee or experiment");
        _reserve(r);
        humanRequired = _needsHuman(r);
        _store(r, humanRequired);
        emit IntentProposed(r.id, r.missionId, r.experimentId, r.recipient, r.token, r.amount, r.category, humanRequired, r.evidenceHash);
    }
    function _store(IntentRequest calldata r, bool humanRequired) private {
        Intent storage i = intents[r.id];
        i.missionId = r.missionId; i.experimentId = r.experimentId; i.recipient = r.recipient;
        i.token = r.token; i.payoutToken = r.payoutToken; i.proposer = msg.sender;
        i.amount = r.amount; i.expiresAt = r.expiresAt; i.category = r.category; i.kind = r.kind;
        i.state = humanRequired ? State.Pending : State.Approved; i.humanRequired = humanRequired;
        i.minPayout = r.minPayout; i.evidenceHash = r.evidenceHash;
    }
    function intentOf(bytes32 id) external view returns (Intent memory) { return intents[id]; }
    function _reserve(IntentRequest calldata r) private {
        Mission storage m = missions[r.missionId];
        require(m.active && block.timestamp < m.endsAt, "mission inactive");
        require(m.committed + r.amount <= m.budget, "mission budget");
        m.committed += r.amount;
        categoryCommitted[r.missionId][r.category] += r.amount;
        if (r.experimentId != bytes32(0)) {
            Experiment storage e = experiments[r.experimentId];
            require(e.active && e.missionId == r.missionId, "experiment inactive");
            require(e.committed + r.amount <= e.budget, "experiment budget");
            e.committed += r.amount;
        }
        reserved[r.token] += r.amount;
    }
    function _needsHuman(IntentRequest calldata r) private view returns (bool) {
        Policy memory p = policy;
        // A conversion's value goes to the swap counterparty, so only a person can vouch for its minimum payout.
        if (!p.autonomyEnabled || r.kind == Kind.Payment || r.payoutToken != address(0) || p.approvalCategories & (1 << r.category) != 0) return true;
        if (r.amount > p.maxTransaction || _todaySpent() + r.amount > p.dailySpend) return true;
        if (categoryCommitted[r.missionId][r.category] > categoryBudget[r.missionId][r.category]) return true;
        return !approvedServices[r.recipient];
    }
    function _todaySpent() private view returns (uint64) {
        return spendDay == block.timestamp / 1 days ? spentToday : 0;
    }
    function approve(bytes32 id) external onlyRole(ROLE_ADMIN | ROLE_APPROVER) notFrozen {
        Intent storage i = intents[id];
        require(i.state == State.Pending && block.timestamp < i.expiresAt, "not pending");
        require(msg.sender != i.proposer, "proposer cannot approve");
        Payee memory payee = payees[i.recipient];
        require(payee.setBy != msg.sender || block.timestamp >= payee.setAt + PAYEE_HOLD, "payee hold");
        i.state = State.Approved; i.approver = msg.sender;
        emit IntentApproved(id, msg.sender);
    }
    function reject(bytes32 id) external onlyRole(ROLE_ADMIN | ROLE_APPROVER) {
        Intent storage i = intents[id];
        require(i.state == State.Pending || i.state == State.Approved, "not open");
        _close(id, i, State.Rejected);
    }
    /// @notice Clears many open intents at once, so a compromised operator cannot trap funds behind junk proposals.
    function rejectMany(bytes32[] calldata ids) external onlyRole(ROLE_ADMIN | ROLE_APPROVER) {
        for (uint256 n; n < ids.length; n++) {
            Intent storage i = intents[ids[n]];
            if (i.state == State.Pending || i.state == State.Approved) _close(ids[n], i, State.Rejected);
        }
    }
    /// @notice Anyone may release the budget held by an expired intent.
    function cancelExpired(bytes32 id) external {
        Intent storage i = intents[id];
        require((i.state == State.Pending || i.state == State.Approved) && block.timestamp >= i.expiresAt, "not expired");
        _close(id, i, State.Cancelled);
    }
    function _close(bytes32 id, Intent storage i, State state) private {
        i.state = state;
        missions[i.missionId].committed -= i.amount;
        categoryCommitted[i.missionId][i.category] -= i.amount;
        if (i.experimentId != bytes32(0)) {
            Experiment storage e = experiments[i.experimentId];
            e.committed -= i.amount;
            // A stopped experiment's budget equals its commitments, so released funds return to the mission.
            if (!e.active) { e.budget -= i.amount; missions[i.missionId].allocated -= i.amount; }
        }
        reserved[i.token] -= i.amount;
        emit IntentClosed(id, state, msg.sender);
    }
    /// @dev Tightening the rules applies to intents already waiting, including ones the agent queued earlier.
    function _assertCurrentPolicy(Intent storage i) private view {
        Policy memory p = policy;
        uint8 bit = uint8(1 << i.category);
        require(i.amount <= p.hardCeiling, "hard ceiling");
        require((p.autonomousCategories | p.approvalCategories) & bit != 0, "category not allowed");
        if (!i.humanRequired) require(p.autonomyEnabled && p.approvalCategories & bit == 0 && i.amount <= p.maxTransaction && approvedServices[i.recipient], "needs approval");
    }
    function _prepare(Intent storage i) private {
        require(i.state == State.Approved && block.timestamp < i.expiresAt, "not executable");
        Mission storage m = missions[i.missionId];
        require(m.active && block.timestamp < m.endsAt, "mission inactive");
        if (i.experimentId != bytes32(0)) require(experiments[i.experimentId].active, "experiment inactive");
        _assertCurrentPolicy(i);
        uint64 day = uint64(block.timestamp / 1 days);
        uint64 today = _todaySpent() + i.amount;
        if (!i.humanRequired) require(today <= policy.dailySpend, "daily limit");
        spendDay = day; spentToday = today;
        i.state = State.Executed;
        reserved[i.token] -= i.amount;
    }
    function execute(bytes32 id) external onlyRole(ROLE_ADMIN | ROLE_OPERATOR) notFrozen nonReentrant {
        Intent storage i = intents[id];
        require(i.payoutToken == address(0), "use corridor");
        _prepare(i);
        _transfer(i.token, i.recipient, i.amount);
        emit IntentExecuted(id, i.recipient, i.token, i.amount);
    }
    /// @notice Convert approved USD₮ on Textile FX and deliver the local stablecoin in one atomic transaction.
    function executeCorridor(bytes32 id, bytes calldata swapData) external onlyRole(ROLE_ADMIN | ROLE_OPERATOR) notFrozen nonReentrant {
        Intent storage i = intents[id];
        require(i.payoutToken != address(0), "not a corridor");
        _prepare(i);
        uint256 soldBefore = IGrowthToken(usdt).balanceOf(address(this));
        uint256 outBefore = IGrowthToken(i.payoutToken).balanceOf(address(this));
        _approve(usdt, reactor, 0);
        _approve(usdt, reactor, i.amount);
        (bool ok,) = reactor.call(swapData);
        require(ok, "swap failed");
        _approve(usdt, reactor, 0);
        require(soldBefore - IGrowthToken(usdt).balanceOf(address(this)) <= i.amount, "overspent");
        uint256 received = IGrowthToken(i.payoutToken).balanceOf(address(this)) - outBefore;
        require(received >= i.minPayout, "below minimum payout");
        _transfer(i.payoutToken, i.recipient, received);
        emit IntentExecuted(id, i.recipient, i.payoutToken, received);
    }

    /// @notice The owner can always exit with anything not reserved for an open payment, even while frozen.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0) && to != address(this) && amount > 0, "invalid withdrawal");
        require(IGrowthToken(token).balanceOf(address(this)) >= reserved[token] + amount, "funds reserved");
        _transfer(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    function _transfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "transfer failed");
    }
    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "approve failed");
    }
}
