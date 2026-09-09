// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/**
 * @title EsopNavOracle
 * @notice Price per ESOP share for a company whose stock is not publicly traded.
 *
 * @dev The valuation is pushed by a designated agent, and that is a deliberate trust
 *      boundary rather than a shortcut. A private company's share price is established by
 *      an independent appraisal — a 409A in the US, an HMRC-agreed valuation for UK EMI
 *      options, a registered-valuer report under Rule 11UA in India — and no on-chain fact
 *      can derive it. Engineering around that would be pretending.
 *
 *      The mitigations are procedural, and all three are here: every update is permanently
 *      attributed to its writer, the writer roster is revocable by `admin`, and a valuation
 *      cannot move further than `maxDeviationBps` in one step, so a fat-fingered or
 *      malicious price cannot silently reprice everyone's collateral in a single call.
 *      Consumers additionally get `updatedAt`, so a stale appraisal can be refused rather
 *      than trusted — which matters here more than for a market feed, because an appraisal
 *      is annual by nature and "stale" is its normal condition.
 *
 *      It implements Chainlink's `AggregatorV3` shape on purpose. A listed issuer swaps
 *      this for a real feed at the same interface, and nothing downstream changes.
 */
contract EsopNavOracle is IAggregatorV3 {
    uint8 public constant override decimals = 8;

    string private _description;

    address public admin;
    address public pendingAdmin;
    mapping(address => bool) public isValuationAgent;

    /// @notice Largest single move allowed, in basis points. Zero disables the check.
    uint16 public maxDeviationBps;

    struct Round {
        int256 answer;
        uint64 updatedAt;
        /// @dev Whoever published it. Attribution is the whole point.
        address publishedBy;
        /// @dev Free-text reference to the appraisal this price came from.
        string basis;
    }

    uint80 public latestRound;
    mapping(uint80 => Round) private _rounds;

    event ValuationPublished(
        uint80 indexed roundId,
        int256 answer,
        address indexed publishedBy,
        string basis,
        uint64 updatedAt
    );
    event ValuationAgentSet(address indexed account, bool enabled);
    event MaxDeviationSet(uint16 bps);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error NotPendingAdmin();
    error NotValuationAgent();
    error ZeroAddress();
    error NonPositivePrice();
    error DeviationTooLarge(int256 previous, int256 next, uint16 maxBps);
    error NoValuationYet();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(string memory description_, address _admin, uint16 _maxDeviationBps) {
        if (_admin == address(0)) revert ZeroAddress();
        _description = description_;
        admin = _admin;
        isValuationAgent[_admin] = true;
        maxDeviationBps = _maxDeviationBps;
        emit AdminTransferred(address(0), _admin);
        emit ValuationAgentSet(_admin, true);
        emit MaxDeviationSet(_maxDeviationBps);
    }

    // ------------------------------------------------------------------ admin

    function setValuationAgent(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        isValuationAgent[account] = enabled;
        emit ValuationAgentSet(account, enabled);
    }

    function setMaxDeviationBps(uint16 bps) external onlyAdmin {
        maxDeviationBps = bps;
        emit MaxDeviationSet(bps);
    }

    /// @dev Two-step, because this address controls who may reprice everyone's collateral.
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    // -------------------------------------------------------------- publishing

    /**
     * @notice Publishes a new valuation.
     * @param answer Price per share, to 8 decimals.
     * @param basis Reference to the appraisal — a 409A report id, a funding round, a URL.
     *        Stored so a reader can trace WHY the number is what it is, rather than having
     *        to take it on faith.
     */
    function publish(int256 answer, string calldata basis) external returns (uint80 roundId) {
        if (!isValuationAgent[msg.sender]) revert NotValuationAgent();
        if (answer <= 0) revert NonPositivePrice();

        if (latestRound != 0 && maxDeviationBps != 0) {
            int256 previous = _rounds[latestRound].answer;
            int256 diff = answer > previous ? answer - previous : previous - answer;
            // Circuit breaker: a valuation that moves this far in one step is far more
            // likely to be a mistake than a revaluation, and it would reprice every
            // outstanding loan at once.
            if (diff * 10_000 > previous * int256(uint256(maxDeviationBps))) {
                revert DeviationTooLarge(previous, answer, maxDeviationBps);
            }
        }

        roundId = ++latestRound;
        _rounds[roundId] = Round({
            answer: answer,
            updatedAt: uint64(block.timestamp),
            publishedBy: msg.sender,
            basis: basis
        });
        emit ValuationPublished(roundId, answer, msg.sender, basis, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------ reads

    function description() external view override returns (string memory) {
        return _description;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        roundId = latestRound;
        if (roundId == 0) revert NoValuationYet();
        Round storage r = _rounds[roundId];
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }

    /// @notice Who published a round, and on what basis. The audit trail, readable on-chain.
    function roundProvenance(uint80 roundId) external view returns (address publishedBy, string memory basis) {
        Round storage r = _rounds[roundId];
        return (r.publishedBy, r.basis);
    }
}
