// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

interface ILedgerFactory { function isWorkspace(address workspace) external view returns (bool); }
interface ILedgerWorkspace { function hasRole(address account, uint8 mask) external view returns (bool); }

/// @notice The public record of what GrowTendril saw, decided, measured and learned.
/// @dev AI and web research stay offchain. Their outputs are committed here as Merkle roots in a hash
///      chain, so a stored record cannot later be changed, reordered or removed without detection.
contract GrowthLedger {
    uint8 private constant WRITERS = 1 | 4; // workspace admin or operator

    struct Checkpoint { bytes32 root; bytes32 head; uint32 records; uint64 at; }
    struct Totals { uint64 customers; uint64 activated; uint64 paying; uint64 revenue; uint64 refunded; }
    struct Outcomes { uint64 customers; uint64 activated; uint64 paying; uint64 revenue; uint64 refunded; uint64 updatedAt; bytes32 evidenceRoot; }

    address public immutable factory;
    mapping(address => uint64) public checkpointCount;
    mapping(address => bytes32) public head;
    mapping(address => mapping(uint64 => Checkpoint)) public checkpoints;
    mapping(address => mapping(bytes32 => Outcomes)) public outcomes;

    event CheckpointCommitted(address indexed workspace, uint64 indexed number, bytes32 root, bytes32 head, uint32 records);
    event OutcomesRecorded(address indexed workspace, bytes32 indexed experimentId, Totals totals, bytes32 evidenceRoot);
    event LearningRecorded(address indexed workspace, bytes32 indexed missionId, bytes32 findingsRoot, uint8 verdict);

    modifier writer(address workspace) {
        require(ILedgerFactory(factory).isWorkspace(workspace) && ILedgerWorkspace(workspace).hasRole(msg.sender, WRITERS), "not authorized");
        _;
    }

    constructor(address factory_) {
        require(factory_.code.length > 0, "missing factory");
        factory = factory_;
    }

    /// @param expectedHead Prevents two writers from silently forking the record.
    function commitCheckpoint(address workspace, bytes32 root, uint32 records, bytes32 expectedHead) external writer(workspace) returns (uint64 number) {
        require(root != bytes32(0) && records > 0 && expectedHead == head[workspace], "stale checkpoint");
        number = ++checkpointCount[workspace];
        bytes32 next = keccak256(abi.encode(expectedHead, workspace, number, root, records));
        head[workspace] = next;
        checkpoints[workspace][number] = Checkpoint(root, next, records, uint64(block.timestamp));
        emit CheckpointCommitted(workspace, number, root, next, records);
    }

    /// @notice Cumulative results. Totals only rise; refunds are recorded rather than erased.
    function recordOutcomes(address workspace, bytes32 experimentId, Totals calldata t, bytes32 evidenceRoot) external writer(workspace) {
        Outcomes storage o = outcomes[workspace][experimentId];
        require(experimentId != bytes32(0) && evidenceRoot != bytes32(0), "invalid outcomes");
        require(t.customers >= o.customers && t.activated >= o.activated && t.paying >= o.paying && t.revenue >= o.revenue && t.refunded >= o.refunded, "totals cannot fall");
        require(t.activated <= t.customers && t.paying <= t.customers && t.refunded <= t.revenue, "inconsistent outcomes");
        o.customers = t.customers; o.activated = t.activated; o.paying = t.paying; o.revenue = t.revenue; o.refunded = t.refunded;
        o.updatedAt = uint64(block.timestamp); o.evidenceRoot = evidenceRoot;
        emit OutcomesRecorded(workspace, experimentId, t, evidenceRoot);
    }

    function recordLearning(address workspace, bytes32 missionId, bytes32 findingsRoot, uint8 verdict) external writer(workspace) {
        require(missionId != bytes32(0) && findingsRoot != bytes32(0), "invalid learning");
        emit LearningRecorded(workspace, missionId, findingsRoot, verdict);
    }

    /// @notice Anyone can prove a receipt, signal or decision belongs to a committed checkpoint.
    function verifyRecord(address workspace, uint64 number, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = checkpoints[workspace][number].root;
        if (root == bytes32(0)) return false;
        // Leaves are hashed once more so an internal tree node can never be presented as a record.
        bytes32 node = keccak256(abi.encode(leaf));
        for (uint256 i; i < proof.length; i++) {
            node = node < proof[i] ? keccak256(abi.encodePacked(node, proof[i])) : keccak256(abi.encodePacked(proof[i], node));
        }
        return node == root;
    }
}
