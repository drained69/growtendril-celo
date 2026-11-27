// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

interface ICampaignToken {
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Prefunded rewards for open campaigns. A business sets the money and the terms aside up front and may name
///         an agent that approves rewards within those terms. Every reward waits a hold period, during which the
///         business can object to it; after that it can only be paid, to its bound recipient.
/// @dev Terms are immutable and amounts come only from the campaign formula. There is no admin, upgrade or pause path.
///      A campaign ID is derived from its funder, so another address cannot claim it first.
contract CampaignEscrow {
    address public immutable token;
    uint256 public immutable refundHold;
    /// @notice Rewards can be approved until this long after the deadline; unused money is returned after it.
    uint256 public constant REVIEW_WINDOW = 7 days;
    uint256 public constant MAX_CAMPAIGN_LENGTH = 365 days;
    bool private entered;

    enum Status { None, Held, Paid, Objected }

    struct Campaign {
        address owner;
        address agent;
        uint256 deadline;
        uint256 available;
        uint256 reserved;
        uint256 base;
        uint256 qualityBonus;
        uint256 outcomeBonus;
        uint256 outcomeCap;
        uint256 slots;
        uint256 queued;
        bytes32 termsHash;
    }
    struct Reward {
        address recipient;
        uint256 amount;
        uint256 quality;
        uint256 outcomes;
        uint256 claimableAt;
        bytes32 evidenceHash;
        Status status;
    }

    mapping(bytes32 => Campaign) public campaigns;
    mapping(bytes32 => mapping(bytes32 => Reward)) public rewards;
    /// @notice Whether a recipient holds a waiting or paid reward in a campaign.
    mapping(bytes32 => mapping(address => bool)) public hasReward;
    /// @notice A recipient the owner has objected to. Only the owner can approve them again.
    mapping(bytes32 => mapping(address => bool)) public objectedTo;

    event CampaignFunded(bytes32 indexed campaignId, address indexed owner, uint256 amount, bytes32 termsHash, address agent);
    event AgentChanged(bytes32 indexed campaignId, address agent);
    event RewardQueued(bytes32 indexed campaignId, bytes32 indexed rewardId, address recipient, uint256 amount, bytes32 evidenceHash, address queuedBy);
    event RewardObjected(bytes32 indexed campaignId, bytes32 indexed rewardId, bytes32 reasonHash);
    event RewardPaid(bytes32 indexed campaignId, bytes32 indexed rewardId, address recipient, uint256 amount);
    event UnusedRefunded(bytes32 indexed campaignId, uint256 amount);

    modifier nonReentrant() { require(!entered, "reentrant"); entered = true; _; entered = false; }

    constructor(address usdc, uint256 hold) {
        require(usdc != address(0) && hold >= 1 days, "invalid configuration");
        ICampaignToken(usdc).balanceOf(address(this)); // Reject a non-token address, including empty-code EOAs.
        token = usdc; refundHold = hold;
    }

    /// @notice The campaign ID a funder receives for a salt.
    function campaignKey(address owner, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }

    /// @param agent May approve rewards within these terms. Zero means only the owner approves.
    function createCampaign(bytes32 salt, address agent, uint256 deadline, uint256 budget, uint256 base, uint256 qualityBonus, uint256 outcomeBonus, uint256 outcomeCap, uint256 slots, bytes32 termsHash) external nonReentrant {
        Campaign storage c = campaigns[campaignKey(msg.sender, salt)];
        require(salt != bytes32(0) && c.owner == address(0), "campaign exists");
        require(deadline > block.timestamp && deadline <= block.timestamp + MAX_CAMPAIGN_LENGTH, "invalid terms");
        require(agent != msg.sender && slots > 0 && slots <= 1000 && base > 0 && termsHash != bytes32(0), "invalid terms");
        require(outcomeCap <= 100 && budget >= (base + qualityBonus + outcomeBonus * outcomeCap) * slots, "insufficient reward pool");
        c.owner = msg.sender; c.agent = agent; c.deadline = deadline; c.available = budget;
        c.base = base; c.qualityBonus = qualityBonus; c.outcomeBonus = outcomeBonus; c.outcomeCap = outcomeCap;
        c.slots = slots; c.termsHash = termsHash;
        pullFunding(campaignKey(msg.sender, salt), budget);
    }

    function pullFunding(bytes32 id, uint256 budget) private {
        uint256 beforeBalance = ICampaignToken(token).balanceOf(address(this));
        (bool ok, bytes memory result) = token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), budget));
        require(ok && (result.length == 0 || abi.decode(result, (bool))) && ICampaignToken(token).balanceOf(address(this)) == beforeBalance + budget, "funding failed");
        Campaign storage c = campaigns[id];
        emit CampaignFunded(id, msg.sender, budget, c.termsHash, c.agent);
    }

    /// @notice Replace or remove the agent at any time. Zero stops automatic approval immediately.
    function setAgent(bytes32 id, address agent) external {
        Campaign storage c = campaigns[id];
        require(c.owner != address(0) && msg.sender == c.owner, "owner only");
        require(agent != c.owner, "invalid agent");
        c.agent = agent;
        emit AgentChanged(id, agent);
    }

    /// @notice Approve one reward. It waits the hold period before it can be paid.
    /// @dev The agent cannot approve the owner, itself, or anyone the owner has objected to.
    function queueReward(bytes32 id, bytes32 rewardId, address recipient, uint256 quality, uint256 outcomes, bytes32 evidenceHash) external nonReentrant {
        Campaign storage c = campaigns[id];
        bool byAgent = msg.sender == c.agent && c.agent != address(0) && !objectedTo[id][recipient];
        require(c.owner != address(0) && (msg.sender == c.owner || byAgent), "not authorized");
        require(block.timestamp <= c.deadline + REVIEW_WINDOW, "campaign closed");
        require(rewardId != bytes32(0) && rewards[id][rewardId].status == Status.None && recipient != address(0) && recipient != c.owner && recipient != c.agent && !hasReward[id][recipient], "duplicate or invalid recipient");
        require(c.queued < c.slots && evidenceHash != bytes32(0), "slots or evidence");
        require(quality <= 100 && outcomes <= c.outcomeCap, "reward exceeds terms");
        uint256 amount = c.base + c.qualityBonus * quality / 100 + c.outcomeBonus * outcomes;
        require(amount <= c.available, "pool exhausted");
        c.available -= amount; c.reserved += amount; c.queued++;
        hasReward[id][recipient] = true;
        rewards[id][rewardId] = Reward(recipient, amount, quality, outcomes, block.timestamp + refundHold, evidenceHash, Status.Held);
        emit RewardQueued(id, rewardId, recipient, amount, evidenceHash, msg.sender);
    }

    /// @notice The owner's final word on a waiting reward. Its money returns to the campaign and its slot is freed.
    /// @param reasonHash Hash of the reason shown to the recipient.
    function object(bytes32 id, bytes32 rewardId, bytes32 reasonHash) external nonReentrant {
        Campaign storage c = campaigns[id];
        Reward storage r = rewards[id][rewardId];
        require(msg.sender == c.owner && r.status == Status.Held && block.timestamp < r.claimableAt && reasonHash != bytes32(0), "cannot object");
        r.status = Status.Objected;
        c.reserved -= r.amount; c.available += r.amount; c.queued--;
        hasReward[id][r.recipient] = false;
        objectedTo[id][r.recipient] = true;
        emit RewardObjected(id, rewardId, reasonHash);
    }

    /// @notice Anyone may relay a payout once the hold has passed; funds always reach the bound recipient.
    function claim(bytes32 id, bytes32 rewardId) external nonReentrant {
        Campaign storage c = campaigns[id];
        Reward storage r = rewards[id][rewardId];
        require(r.status == Status.Held && block.timestamp >= r.claimableAt, "not claimable");
        r.status = Status.Paid;
        c.reserved -= r.amount;
        transferToken(r.recipient, r.amount);
        emit RewardPaid(id, rewardId, r.recipient, r.amount);
    }

    /// @notice Returns money no reward is using, once rewards can no longer be approved.
    function refundUnused(bytes32 id) external nonReentrant {
        Campaign storage c = campaigns[id];
        require(msg.sender == c.owner && block.timestamp > c.deadline + REVIEW_WINDOW, "review still open");
        uint256 amount = c.available;
        require(amount > 0, "nothing unused");
        c.available = 0;
        transferToken(c.owner, amount);
        emit UnusedRefunded(id, amount);
    }

    function transferToken(address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "token transfer failed");
    }
}
