// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

/**
 * @title EsopNavOracle
 * @notice Price per ESOP share for a company whose stock is not publicly traded.
 *
 * @dev READ THIS FIRST, because the interface invites the wrong assumption: this contract
 *      does NOT fetch anything from Chainlink. It is not a Chainlink feed, it is not a
 *      Chainlink consumer, and no Chainlink node writes to it. The price is whatever a
 *      valuation agent last passed to `publish`, and it changes only when a human calls
 *      that function.
 *
 *      What is Chainlink about it is the SHAPE: it implements `AggregatorV3`, so a consumer
 *      cannot tell it apart from a real feed and an issuer who later lists can swap in one
 *      without touching the pool. The lending pool's other feed — the stablecoin peg — IS a
 *      genuine Chainlink feed, live on Hedera testnet. One of the two is real and the other
 *      is published by hand, which is exactly the distinction worth being plain about.
 *
 *      The valuation is pushed by a designated agent, and that is a deliberate trust
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
 *      The `roundId` sequence is ours and counts publications, not Chainlink rounds; the
 *      `answeredInRound` field exists to satisfy the interface and always equals `roundId`.
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

    /**
     * @notice Deploys the feed and names its first admin, who is also its first agent.
     *
     * @dev No price exists until someone calls `publish`. Until then `latestRoundData`
     *      reverts with `NoValuationYet` rather than returning zero, so a consumer cannot
     *      mistake an unconfigured feed for a worthless share. The lending pool depends on
     *      that: a zero price would make every loan infinitely levered and seizable.
     *
     * @param description_     Human-readable pair name, e.g. "ESOP / USD (Acme Ltd)".
     * @param _admin           First admin, and implicitly the first valuation agent.
     * @param _maxDeviationBps Largest single move allowed, in basis points. Zero disables
     *                         the check, which is only sensible before the first real price.
     */
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

    /**
     * @notice Appoints or removes an address allowed to publish valuations.
     * @dev This roster is the trust boundary of the whole lending leg — an agent's number
     *      decides what everyone's collateral is worth. It is revocable for that reason, and
     *      revocation is retroactive only in the sense that it stops future writes: rounds
     *      already published stay, permanently attributed to whoever wrote them.
     */
    function setValuationAgent(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        isValuationAgent[account] = enabled;
        emit ValuationAgentSet(account, enabled);
    }

    /**
     * @notice Sets the largest single price move an agent may publish, in basis points.
     *
     * @dev The circuit breaker on a fat finger. At 3,000 a price can move 30% in one step, so
     *      a misplaced decimal point — the classic failure, 10x or 0.1x — is refused instead
     *      of repricing every outstanding loan at once.
     *
     *      Zero disables the check entirely. That is the escape hatch for a genuine step
     *      change (a down round that really is 80% off), and it is why this is settable:
     *      relax it, publish, tighten it again, with all three transactions on the record.
     */
    function setMaxDeviationBps(uint16 bps) external onlyAdmin {
        maxDeviationBps = bps;
        emit MaxDeviationSet(bps);
    }

    /**
     * @notice Step one of a two-step admin handover. Nothing changes until `acceptAdmin`.
     * @dev Two-step, because this address controls who may reprice everyone's collateral.
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    /// @notice Step two of the handover: the incoming admin claims the role.
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

    /// @notice Human-readable pair name, set at deployment. Part of the AggregatorV3 shape.
    function description() external view override returns (string memory) {
        return _description;
    }

    /**
     * @notice The latest published valuation, in Chainlink's `AggregatorV3` shape.
     *
     * @dev Reverts with `NoValuationYet` before the first `publish` rather than returning a
     *      zero answer, because a consumer treating zero as a price would conclude every
     *      grant is worthless and every loan is underwater.
     *
     *      Two fields are shaped rather than meaningful, and a consumer should not read them
     *      as it would from a real feed: `startedAt` equals `updatedAt` (there is no round to
     *      start — publication is the whole event), and `answeredInRound` always equals
     *      `roundId`, so the usual `answeredInRound < roundId` staleness idiom can never fire
     *      here. Check `updatedAt` against your own maximum age instead; that is exactly what
     *      `ESOPLendingPool.setFeeds` configures a bound for.
     *
     * @return roundId         Our own publication counter, not a Chainlink round.
     * @return answer          Price per share, to 8 decimals. Always positive.
     * @return startedAt       Same as `updatedAt`. Present for interface compatibility.
     * @return updatedAt       When this valuation was published. The field that matters.
     * @return answeredInRound Same as `roundId`. Present for interface compatibility.
     */
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

    /**
     * @notice Who published a round, and on what basis. The audit trail, readable on-chain.
     * @dev The answer to "why is the share price this number", which no real Chainlink feed
     *      can give you and a hand-published one must. Returns zeroes for a round that was
     *      never published.
     */
    function roundProvenance(uint80 roundId) external view returns (address publishedBy, string memory basis) {
        Round storage r = _rounds[roundId];
        return (r.publishedBy, r.basis);
    }
}
