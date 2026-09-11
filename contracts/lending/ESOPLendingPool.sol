// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IAtsEsop, IHoldTypes} from "../interfaces/IAtsEsop.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";

/**
 * @title ESOPLendingPool
 * @notice Lends stablecoin against vested ESOPs, using an ERC-1400 hold as collateral.
 *
 * @dev The mechanic worth understanding: this pool never takes custody. The employee places
 *      a HOLD over their own vested balance naming this contract as escrow, and the tokens
 *      stay in their wallet, marked as held. Only on liquidation does anything move, and
 *      that transfer still runs the token's full compliance stack.
 *
 *      Three consequences, all of them the point:
 *        * the borrower keeps their shares, including whatever rights attach to them;
 *        * the issuer keeps freeze and clawback authority over the position;
 *        * the pool never needs to be trusted with custody, because it never has any.
 *
 *      Only *vested* equity can be pledged, and that falls out of the design rather than
 *      being enforced here: unvested tranches are locked, not held, and ATS will not let a
 *      hold be placed over a locked balance. Unvested equity is also forfeitable by the
 *      issuer, so it would be poor collateral even if it could be pledged.
 *
 *      This is the Aave Horizon shape — permissioned collateral, permissionless stablecoin
 *      — with the custody leg removed because ERC-1400 holds make it unnecessary.
 */
contract ESOPLendingPool is ReentrancyGuard {
    // CEI ordering is the primary defence throughout; OpenZeppelin's `nonReentrant` is the
    // second layer, and it earns its place here -- the pool calls out to both a third-party
    // stablecoin and an ATS diamond that delegatecalls to ~100 facets.

    // ------------------------------------------------------------------ types

    enum LoanStatus {
        None,
        Active,
        Repaid,
        Liquidated
    }

    struct Loan {
        address borrower;
        bytes32 partition;
        uint256 holdId;
        /// @dev Stablecoin borrowed, in the stablecoin's own decimals.
        uint256 principal;
        uint256 repaid;
        uint64 openedAt;
        uint64 maturity;
        uint16 aprBps;
        LoanStatus status;
    }

    // ----------------------------------------------------------------- config

    /// @dev One hundred percent, in basis points.
    uint16 private constant BPS = 10_000;

    IAtsEsop public immutable esop;
    IERC20Minimal public immutable stable;
    uint8 private immutable _stableDecimals;

    address public admin;
    address public pendingAdmin;

    /**
     * @notice Price per ESOP share.
     * @dev In this deployment this is `EsopNavOracle`, which is Chainlink-SHAPED but not a
     *      Chainlink feed: a valuation agent publishes the appraisal by hand. Only the
     *      interface is shared, so a listed issuer can swap in a real feed unchanged.
     */
    IAggregatorV3 public navFeed;

    /**
     * @notice Stablecoin peg feed. A depeg silently inflates what a borrower actually owes.
     * @dev This one IS a real Chainlink feed (USDC/USD on Hedera testnet), unlike `navFeed`.
     */
    IAggregatorV3 public stableFeed;

    /// @dev Per-feed, because heartbeats differ wildly. A share appraisal is annual by
    ///      nature; a market feed that has not updated in a day is broken. One global
    ///      constant would either brick the pool or wave through stale prices.
    uint64 public navMaxAge;
    uint64 public stableMaxAge;

    /// @notice Largest fraction of collateral value that may be borrowed, in basis points.
    uint16 public maxLtvBps;
    /// @notice Above this, the loan may be liquidated.
    uint16 public liquidationLtvBps;
    uint16 public aprBps;

    /// @notice Shortest and longest hold expiry the pool will accept as collateral.
    uint64 public minTerm;
    uint64 public maxTerm;

    /**
     * @notice How long before the hold expires a loan becomes seizable.
     * @dev Load-bearing, not a nicety. ATS refuses `executeHoldByPartition` once a hold has
     *      expired — past that point the borrower can reclaim the collateral and the pool is
     *      holding an unsecured debt. So maturity is set BEFORE the hold expires, leaving a
     *      window in which the loan is liquidatable and the hold is still executable.
     */
    uint64 public liquidationGrace;

    uint256 public nextLoanId = 1;
    mapping(uint256 => Loan) private _loans;
    mapping(address => uint256[]) private _loansOf;

    // ----------------------------------------------------------------- events

    event LoanOpened(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 principal,
        uint256 collateral,
        uint64 maturity
    );
    event Repaid(uint256 indexed loanId, uint256 amount, uint256 outstanding);
    event LoanClosed(uint256 indexed loanId, uint256 collateralReleased);
    event Liquidated(uint256 indexed loanId, uint256 debt, uint256 collateralTaken, uint256 surplusReturned);
    event UnusedHoldReleased(address indexed borrower, bytes32 partition, uint256 holdId, uint256 amount);
    event PledgedAndBorrowed(address indexed borrower, bytes32 partition, uint256 holdId, uint256 indexed loanId);
    event SeizedSharesWithdrawn(bytes32 partition, address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    // slither-disable-next-line unindexed-event-address
    // Feed changes are rare and read from a full log, not filtered by address.
    event FeedsSet(address navFeed, address stableFeed, uint64 navMaxAge, uint64 stableMaxAge);
    event RiskParamsSet(uint16 maxLtvBps, uint16 liquidationLtvBps, uint16 aprBps, uint64 minTerm, uint64 maxTerm);
    event LiquidityAdded(address indexed from, uint256 amount);
    event LiquidityRemoved(address indexed to, uint256 amount);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);

    // ----------------------------------------------------------------- errors

    error NotAdmin();
    error NotPendingAdmin();
    error NotBorrower();
    error ZeroAddress();
    error ZeroAmount();
    error UnknownLoan(uint256 loanId);
    error LoanNotActive(uint256 loanId);
    error PoolNotEscrow(address escrow);
    error PoolNotDestination(address destination);
    error HoldNeverExpires();
    error HoldTermTooShort(uint64 expiry, uint64 required);
    error HoldTermTooLong(uint64 expiry, uint64 allowed);
    error GraceExceedsMinTerm(uint64 grace, uint64 minTerm);
    error CollateralAlreadyPledged(uint256 holdId);
    error ExceedsMaxLtv(uint256 requested, uint256 allowed);
    error StalePrice(address feed, uint256 updatedAt, uint64 maxAge);
    error InvalidPrice(address feed, int256 answer);
    error StablecoinDepegged(int256 answer);
    error InsufficientLiquidity(uint256 available, uint256 requested);
    error Healthy(uint256 ltvBps, uint16 threshold);
    error TransferFailed();
    error TokenCallFailed();
    error NoRequestedAmount();
    /// @dev Carries a different remedy from the other guards: reclaim on the token, not release here.
    error HoldExpiredUseReclaim(uint64 expiry);
    /// @dev This asset has its own way out; using the generic one would duplicate it.
    error NotRescuable(address token);
    /// @dev A risk parameter that would brick the pool or make every new loan liquidatable.
    error InvalidRiskParams();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @dev One live loan per hold. Without this, the same collateral could back several.
    mapping(bytes32 => bool) private _pledged;

    /**
     * @notice Deploys a pool lending one stablecoin against one ESOP token.
     *
     * @dev Both tokens are immutable. Pairing them at construction rather than configuring
     *      them later is what lets a reader reason about the pool at all: there is exactly
     *      one collateral asset and exactly one cash asset, and neither can be swapped out
     *      from under an open loan.
     *
     *      Deployment is not finished when this returns. The pool must then be onboarded on
     *      the ESOP token as a holder (KYC plus allowlist, because a liquidation transfers
     *      shares TO it and compliance applies to contracts too), granted the partition's
     *      participant role if `pledgeAndBorrow` is to be used, pointed at its feeds via
     *      `setFeeds`, and funded via `addLiquidity`. See `scripts/testnet-deploy-lending.ts`.
     *
     * @param _esop           The ATS security token accepted as collateral.
     * @param _stable         The stablecoin lent out and repaid.
     * @param stableDecimals_ Cached rather than read, because not every stablecoin exposes
     *                        `decimals()` and a wrong value here silently misprices every loan.
     * @param _admin          First admin. Sets risk parameters and feeds, and can withdraw liquidity.
     */
    constructor(IAtsEsop _esop, IERC20Minimal _stable, uint8 stableDecimals_, address _admin) {
        if (address(_esop) == address(0) || address(_stable) == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }
        esop = _esop;
        stable = _stable;
        _stableDecimals = stableDecimals_;
        admin = _admin;

        // Through the same validation the setter uses, so the shipped defaults cannot quietly
        // drift outside the invariant every later change is held to.
        _setRiskParams(
            2_500, // 25% — an illiquid, appraisal-priced asset does not support more
            4_000,
            800,
            7 days,
            730 days,
            3 days
        );
        navMaxAge = 400 days; // an appraisal is annual; "stale" is its normal condition
        stableMaxAge = 2 days;

        emit AdminTransferred(address(0), _admin);
    }

    // ------------------------------------------------------------------ admin

    /**
     * @notice Points the pool at its price feeds and sets how stale each may be.
     *
     * @dev Both addresses are required. A zero feed is not a "disabled" state — every
     *      valuation reads both, so setting one to zero would revert `collateralValue` and
     *      with it every borrow, every liquidation and the borrowable figure the portal
     *      shows. The pool would look alive and be unusable.
     *
     *      Staleness bounds are PER FEED and both must be non-zero. A zero bound means
     *      "nothing is ever fresh enough" and bricks the pool just as thoroughly. They differ
     *      by roughly two orders of magnitude on purpose: a share appraisal is annual by
     *      nature, so being months old is its normal condition, while a market feed that has
     *      not moved in a day is broken. One shared constant would either wave through a
     *      stale market price or refuse a perfectly good valuation.
     *
     * @param _navFeed      Price per ESOP share. Chainlink-shaped, so a listed issuer swaps in a real feed.
     * @param _stableFeed   Stablecoin peg feed. A depeg silently inflates what a borrower owes.
     * @param _navMaxAge    Seconds before the NAV answer is refused. Expect hundreds of days.
     * @param _stableMaxAge Seconds before the peg answer is refused. Expect a day or two.
     */
    function setFeeds(
        IAggregatorV3 _navFeed,
        IAggregatorV3 _stableFeed,
        uint64 _navMaxAge,
        uint64 _stableMaxAge
    ) external onlyAdmin {
        if (address(_navFeed) == address(0) || address(_stableFeed) == address(0)) revert ZeroAddress();
        if (_navMaxAge == 0 || _stableMaxAge == 0) revert ZeroAmount();
        navFeed = _navFeed;
        stableFeed = _stableFeed;
        navMaxAge = _navMaxAge;
        stableMaxAge = _stableMaxAge;
        emit FeedsSet(address(_navFeed), address(_stableFeed), _navMaxAge, _stableMaxAge);
    }

    /**
     * @notice Sets the lending ceiling, the liquidation threshold, the rate and the term window.
     *
     * @dev Every parameter here is bounded rather than trusted. The admin is the issuer, not an
     *      adversary, but a fat-fingered zero reprices or bricks every outstanding loan in one
     *      call, and there is no undo once a liquidator has acted on it.
     *
     *      Changes apply to FUTURE loans only for the rate — `aprBps` is copied into each loan
     *      at open — but the LTV threshold is read live, so raising it can make existing
     *      positions liquidatable immediately. That is deliberate: risk parameters that could
     *      not respond to a collapse in the share price would not be risk parameters.
     *
     * @param _maxLtvBps         Most that may be borrowed against collateral value. Non-zero, under 100%.
     * @param _liquidationLtvBps Seizure threshold. Must sit strictly above `_maxLtvBps`.
     * @param _aprBps            Simple annual rate copied into new loans. Capped at 100%.
     * @param _minTerm           Shortest hold expiry accepted as collateral.
     * @param _maxTerm           Longest hold expiry accepted. ATS caps holds well below this in practice.
     * @param _liquidationGrace  How long before hold expiry a loan matures. Must be under `_minTerm`.
     */
    function setRiskParams(
        uint16 _maxLtvBps,
        uint16 _liquidationLtvBps,
        uint16 _aprBps,
        uint64 _minTerm,
        uint64 _maxTerm,
        uint64 _liquidationGrace
    ) external onlyAdmin {
        _setRiskParams(_maxLtvBps, _liquidationLtvBps, _aprBps, _minTerm, _maxTerm, _liquidationGrace);
    }

    /// @dev Shared by the constructor and the setter so both are held to the same invariant.
    function _setRiskParams(
        uint16 _maxLtvBps,
        uint16 _liquidationLtvBps,
        uint16 _aprBps,
        uint64 _minTerm,
        uint64 _maxTerm,
        uint64 _liquidationGrace
    ) private {
        // Every one of these can brick or endanger the pool if left unchecked, and an admin
        // typo is a far likelier cause than malice — which is exactly why they are bounded
        // here rather than trusted to the caller.

        // A zero ceiling means nobody can ever borrow; a ceiling of 100% or more means a loan
        // is underwater the instant it opens.
        if (_maxLtvBps == 0 || _maxLtvBps >= BPS) revert InvalidRiskParams();

        // Liquidation must sit ABOVE the borrowing ceiling. Equal or below and every new loan
        // is immediately liquidatable, which would let anyone seize collateral from a
        // borrower who did nothing wrong.
        if (_liquidationLtvBps <= _maxLtvBps || _liquidationLtvBps > BPS) revert InvalidRiskParams();

        // A rate above 100% a year is not a lending product. Zero is allowed — an interest-free
        // employee facility is a legitimate thing for an issuer to offer.
        if (_aprBps > BPS) revert InvalidRiskParams();

        // A term window that is empty or inverted accepts no hold at all.
        if (_minTerm == 0 || _maxTerm < _minTerm) revert InvalidRiskParams();

        // A grace longer than the shortest term would put maturity before the loan opened.
        if (_liquidationGrace == 0 || _liquidationGrace >= _minTerm) {
            revert GraceExceedsMinTerm(_liquidationGrace, _minTerm);
        }

        maxLtvBps = _maxLtvBps;
        liquidationLtvBps = _liquidationLtvBps;
        aprBps = _aprBps;
        minTerm = _minTerm;
        maxTerm = _maxTerm;
        liquidationGrace = _liquidationGrace;
        emit RiskParamsSet(_maxLtvBps, _liquidationLtvBps, _aprBps, _minTerm, _maxTerm);
    }

    /**
     * @notice Deposits stablecoin for the pool to lend out.
     *
     * @dev Permissionless, and deliberately not a share-issuing deposit: there is no LP token
     *      and no claim on interest. Funding here is a contribution to a facility the issuer
     *      operates, and only `admin` can take stablecoin back out. That asymmetry is the
     *      honest description of what this is — an employer-run employee lending facility,
     *      not a yield venue — and pretending otherwise would invite deposits under a promise
     *      the contract does not make.
     *
     *      Caller must have approved the pool for `amount` first.
     */
    function addLiquidity(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (!stable.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit LiquidityAdded(msg.sender, amount);
    }

    /**
     * @notice Withdraws lendable stablecoin from the pool.
     *
     * @dev Deliberately NOT capped at some "unused" figure, because there is no such figure
     *      to compute: outstanding loans are owed in the future and the pool's balance is
     *      what is here now. An admin can drain the pool, and that is a trust assumption
     *      stated rather than engineered around — an employer who wanted to strand its own
     *      employees has simpler ways.
     *
     *      What it cannot touch is collateral. Pledged equity is not in this contract at all;
     *      it sits in the borrower's wallet under a hold. This moves cash only.
     *
     * @param to     Recipient of the stablecoin.
     * @param amount Amount in the stablecoin's own decimals. Reverts if the pool is short.
     */
    function removeLiquidity(address to, uint256 amount) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        emit LiquidityRemoved(to, amount);
        if (!stable.transfer(to, amount)) revert TransferFailed();
    }

    /**
     * @notice Moves shares this pool seized in a liquidation out to a nominated holder.
     *
     * @dev Liquidation is the only way equity ever lands here, and once it does there was no
     *      way out: every other path in this contract releases collateral back to a borrower
     *      or executes a hold, and neither applies to shares the pool already owns outright.
     *      A retired pool would keep them forever. That happened — a pool superseded during
     *      development still holds 2,174 shares with no function able to move them.
     *
     *      Safe to expose because the pool NEVER custodies live collateral. A pledge stays in
     *      the borrower's own wallet, marked held; only `executeHoldByPartition` during a
     *      liquidation transfers anything here. So an ESOP balance on this contract is
     *      seized equity or an accidental transfer, never somebody's active pledge, and this
     *      cannot reach into a loan that is still running.
     *
     *      Compliance is NOT bypassed. `transferByPartition` still enforces KYC and the
     *      allowlist on `to`, so seized shares can only move to an address the issuer has
     *      already admitted — which is the point of holding them in a regulated token.
     *
     * @param partition Partition the seized shares sit on.
     * @param to        Recipient. Must be KYC'd and allowlisted or the token will refuse.
     * @param amount    How many shares to move.
     */
    function withdrawSeizedShares(
        bytes32 partition,
        address to,
        uint256 amount
    ) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        emit SeizedSharesWithdrawn(partition, to, amount);
        // slither-disable-next-line unused-return
        // transferByPartition returns the partition key, not a success flag; it reverts on failure.
        esop.transferByPartition(partition, IAtsEsop.BasicTransferInfo({to: to, value: amount}), "");
    }

    /**
     * @notice Recovers an unrelated ERC-20 that ended up here.
     *
     * @dev Anyone can send any token to any address, so a pool that cannot give one back is
     *      a one-way door. This is only for tokens with no other route out.
     *
     *      Deliberately refuses the two assets that DO have a route, rather than quietly
     *      duplicating them. The stablecoin leaves through `removeLiquidity`, which is what
     *      lenders' accounting reads; the ESOP token leaves through `withdrawSeizedShares`,
     *      which is partition-aware and keeps the compliance checks. Two ways to move the
     *      same asset is how one of them ends up forgotten in a review.
     */
    function rescueToken(address token, address to, uint256 amount) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (token == address(stable) || token == address(esop)) revert NotRescuable(token);
        emit TokenRescued(token, to, amount);
        if (!IERC20Minimal(token).transfer(to, amount)) revert TransferFailed();
    }

    /**
     * @notice Step one of a two-step admin handover. Nothing changes until `acceptAdmin`.
     * @dev Two-step because this role sets the liquidation threshold and can withdraw the
     *      pool's cash. A one-step transfer to a typo'd address would leave the pool with
     *      unchangeable risk parameters and unrecoverable liquidity.
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    /**
     * @notice Step two of the handover: the incoming admin claims the role.
     * @dev Requiring the new admin to send this transaction is what proves the key is live
     *      before the old admin loses it.
     */
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    // --------------------------------------------------------------- borrowing

    /**
     * @notice Opens a loan against a hold the borrower has already placed on their ESOPs.
     * @dev The hold must already exist and name this pool as both escrow and destination.
     *      The borrower creates it themselves (or has it relayed with their EIP-712
     *      signature) — this contract never reaches into their balance uninvited.
     */
    function borrow(bytes32 partition, uint256 holdId, uint256 amount) external nonReentrant returns (uint256 loanId) {
        return _open(partition, msg.sender, holdId, amount);
    }

    /**
     * @notice Opens a loan on behalf of a borrower, for the amount they signed for.
     *
     * @dev Permissionless, and safe to be: the amount is read from the hold's `data`, which
     *      is inside the EIP-712 struct the borrower signed to create it. So the collateral,
     *      the escrow, the expiry AND the sum borrowed are all their stated intent — a
     *      relayer executing this is carrying out an instruction, not making a decision, and
     *      the funds go to the borrower either way.
     *
     *      This is what lets an employee borrow from an account that has never held gas.
     *      Without it the alternative is a trusted relayer role, which would mean somebody
     *      else could decide how much debt an employee takes on.
     */
    function borrowFor(bytes32 partition, address borrower, uint256 holdId) external nonReentrant returns (uint256) {
        (, , , , bytes memory data, , ) = esop.getHoldForByPartition(
            IHoldTypes.HoldIdentifier({partition: partition, tokenHolder: borrower, holdId: holdId})
        );
        if (data.length != 32) revert NoRequestedAmount();
        return _open(partition, borrower, holdId, abi.decode(data, (uint256)));
    }

    /**
     * @notice Places the borrower's signed hold and opens the loan against it, in one call.
     *
     * @dev Prefer this over `borrowFor`. Pledging and borrowing are one intent — nobody wants
     *      their shares locked up without the money — but splitting them across two
     *      transactions makes them two outcomes. If the hold lands and the loan does not, the
     *      borrower is left holding neither: shares immobilised, nothing borrowed. That is not
     *      a state anyone asked for, and it happened in testing.
     *
     *      Doing both here makes it atomic. If `_open` reverts for any reason — the pool ran
     *      dry, the price moved, the term is wrong — the hold creation reverts with it and the
     *      borrower is exactly where they started. There is no partial outcome to recover from.
     *
     *      It also removes a whole class of bug: `protectedCreateHoldByPartition` returns the
     *      new id directly, so nothing has to infer it afterwards. Inferring it from
     *      `getHoldCountForByPartition` is wrong — ids keep climbing while the count falls on
     *      release — and that mistake cost a reverted borrow before it was found.
     *
     *      Requires this pool to hold the partition's participant role, which is a deployment
     *      step (`testnet:grant-relayer`, pointed at the pool). The role governs who may
     *      submit a signed hold, never whose tokens may move: the signature still has to be
     *      the borrower's, so the pool cannot pledge anyone's shares on its own.
     *
     *      Permissionless, like `borrowFor`, and for the same reason — every term of the loan
     *      comes out of the struct the borrower signed.
     *
     * @param partition     The partition the shares sit on.
     * @param borrower      Whose shares are pledged and who receives the funds.
     * @param protectedHold The signed hold: amount, expiry, escrow, destination, and the sum
     *                      to borrow encoded in `hold.data`.
     * @param signature     The borrower's EIP-712 signature over `protectedHold`.
     */
    function pledgeAndBorrow(
        bytes32 partition,
        address borrower,
        IHoldTypes.ProtectedHold calldata protectedHold,
        bytes calldata signature
    ) external nonReentrant returns (uint256 loanId) {
        // Check the destination before creating anything. A hold escrowed to someone else
        // would leave this pool lending against collateral it could never seize, and the
        // signature alone does not prevent that — the borrower could have signed it happily.
        if (protectedHold.hold.escrow != address(this)) revert PoolNotEscrow(protectedHold.hold.escrow);
        if (protectedHold.hold.to != address(this)) revert PoolNotDestination(protectedHold.hold.to);
        if (protectedHold.hold.data.length != 32) revert NoRequestedAmount();

        (bool created, uint256 holdId) = esop.protectedCreateHoldByPartition(
            partition,
            borrower,
            protectedHold,
            signature
        );
        if (!created) revert TokenCallFailed();

        loanId = _open(partition, borrower, holdId, abi.decode(protectedHold.hold.data, (uint256)));
        emit PledgedAndBorrowed(borrower, partition, holdId, loanId);
    }

    function _open(
        bytes32 partition,
        address borrower,
        uint256 holdId,
        uint256 amount
    ) private returns (uint256 loanId) {
        if (amount == 0) revert ZeroAmount();

        bytes32 key = keccak256(abi.encode(partition, borrower, holdId));
        if (_pledged[key]) revert CollateralAlreadyPledged(holdId);

        (uint256 collateral, uint64 expiry) = _readHold(partition, borrower, holdId);

        // A hold with no expiry can never be reclaimed by the holder and is immune to the
        // issuer's clawback for as long as it stands. Accepting one would let a borrower
        // park unvested-adjacent equity beyond anyone's reach; refuse it outright.
        if (expiry == 0) revert HoldNeverExpires();
        if (expiry < block.timestamp + minTerm) revert HoldTermTooShort(expiry, uint64(block.timestamp) + minTerm);
        if (expiry > block.timestamp + maxTerm) revert HoldTermTooLong(expiry, uint64(block.timestamp) + maxTerm);

        uint256 value = collateralValue(collateral);
        uint256 allowed = (value * maxLtvBps) / 10_000;
        if (amount > allowed) revert ExceedsMaxLtv(amount, allowed);

        uint256 liquidity = stable.balanceOf(address(this));
        if (liquidity < amount) revert InsufficientLiquidity(liquidity, amount);

        loanId = nextLoanId++;
        _pledged[key] = true;
        _loans[loanId] = Loan({
            borrower: borrower,
            partition: partition,
            holdId: holdId,
            principal: amount,
            repaid: 0,
            openedAt: uint64(block.timestamp),
            // Deliberately BEFORE the hold expires. ATS will not execute an expired hold,
            // so a loan maturing at the same instant could never be seized -- the borrower
            // would simply reclaim the collateral and leave the debt unsecured.
            maturity: expiry - liquidationGrace,
            aprBps: aprBps,
            status: LoanStatus.Active
        });
        _loansOf[borrower].push(loanId);

        emit LoanOpened(loanId, borrower, amount, collateral, expiry);
        if (!stable.transfer(borrower, amount)) revert TransferFailed();
    }

    /**
     * @notice Repays part or all of a loan. Full repayment releases the collateral.
     * @dev Anyone may repay on a borrower's behalf — it can only help them, and refusing
     *      would strand a borrower whose own account cannot transact.
     *
     *      Offering more than is owed takes only what is owed rather than reverting.
     *      Interest accrues per second, so anyone aiming at the exact figure is guessing at
     *      what it will be when the transaction mines; punishing them for guessing high
     *      would leave overshooting as the failure mode and undershooting — which silently
     *      leaves the loan open — as the safe one. That is backwards.
     */
    function repay(uint256 loanId, uint256 amount) external nonReentrant {
        Loan storage loan = _requireActive(loanId);
        if (amount == 0) revert ZeroAmount();

        uint256 owed = debtOf(loanId);
        uint256 pay = amount > owed ? owed : amount;

        loan.repaid += pay;
        // slither-disable-next-line incorrect-equality
        // `pay` is clamped to `owed` immediately above, so this equality cannot drift.
        bool cleared = pay == owed;
        if (cleared) loan.status = LoanStatus.Repaid; // effect before interactions

        if (!stable.transferFrom(msg.sender, address(this), pay)) revert TransferFailed();
        emit Repaid(loanId, pay, owed - pay);

        // slither-disable-next-line reentrancy-benign,reentrancy-events
        // Status is already terminal above, and the function is nonReentrant. Re-entering
        // hits LoanNotActive.
        if (cleared) emit LoanClosed(loanId, _releaseIfPossible(loan));
    }

    /**
     * @notice Repays a loan in full, computing the debt on-chain.
     * @dev Interest accrues per second, so a caller who reads `debtOf` and then submits that
     *      number always underpays by whatever the transaction took to mine, and the loan
     *      silently stays open. Computing it here removes the race entirely.
     */
    function repayAll(uint256 loanId) external nonReentrant {
        _repayAllFrom(loanId, msg.sender);
    }

    /**
     * @notice Repays a loan in full using the BORROWER's own stablecoin.
     *
     * @dev Pairs with `borrowFor`. Repaying means moving the borrower's money, and an
     *      employee whose account has never held gas cannot send an `approve()` — so the
     *      authorisation is their EIP-2612 permit signature instead, and this call merely
     *      executes it. Permissionless for the same reason `borrowFor` is: without an
     *      allowance from the borrower it simply reverts, so a caller can compel nothing.
     *
     *      Kept separate from `repayAll` on purpose. Which account the money comes from is
     *      exactly the sort of thing that should be visible in the function name rather
     *      than inferred from who happened to send the transaction.
     */
    function repayAllFor(uint256 loanId) external nonReentrant {
        _repayAllFrom(loanId, _loans[loanId].borrower);
    }

    function _repayAllFrom(uint256 loanId, address payer) private {
        Loan storage loan = _requireActive(loanId);
        uint256 owed = debtOf(loanId);

        loan.repaid += owed;
        loan.status = LoanStatus.Repaid; // effect before interactions

        if (!stable.transferFrom(payer, address(this), owed)) revert TransferFailed();
        emit Repaid(loanId, owed, 0);

        emit LoanClosed(loanId, _releaseIfPossible(loan));
    }

    /**
     * @notice Seizes collateral from an unhealthy or matured loan.
     * @dev Takes only what covers the debt and releases the rest. `executeHoldByPartition`
     *      accepts an amount, so there is no reason to sweep the whole position and owe the
     *      borrower a refund — a surplus that never leaves their wallet cannot be lost.
     *
     *      Permissionless on purpose: a liquidation that only the pool operator can trigger
     *      is a liquidation that does not happen at 3am.
     */
    function liquidate(uint256 loanId) external nonReentrant {
        Loan storage loan = _requireActive(loanId);

        (uint256 collateral, ) = _readHold(loan.partition, loan.borrower, loan.holdId);
        uint256 debt = debtOf(loanId);
        uint256 value = collateralValue(collateral);

        uint256 ltvBps = value == 0 ? type(uint256).max : (debt * 10_000) / value;
        bool matured = block.timestamp >= loan.maturity;
        if (!matured && ltvBps < liquidationLtvBps) revert Healthy(ltvBps, liquidationLtvBps);

        // Tokens needed to cover the debt, rounded up so the pool is never left short.
        uint256 take = value == 0 ? collateral : (debt * collateral + value - 1) / value;
        if (take > collateral) take = collateral;
        uint256 surplus = collateral - take;

        loan.status = LoanStatus.Liquidated; // effect before interactions
        _pledged[keccak256(abi.encode(loan.partition, loan.borrower, loan.holdId))] = false;

        IHoldTypes.HoldIdentifier memory id = IHoldTypes.HoldIdentifier({
            partition: loan.partition,
            tokenHolder: loan.borrower,
            holdId: loan.holdId
        });

        // Executing to this pool requires the pool to be KYC'd and allowlisted on the token
        // — confirmed by spike #1. That is the compliance stack working, not a workaround:
        // an address that can end up owning shares should be a known holder.
        (bool seized, ) = esop.executeHoldByPartition(id, address(this), take);
        if (!seized) revert TokenCallFailed();
        if (surplus > 0 && !esop.releaseHoldByPartition(id, surplus)) revert TokenCallFailed();

        emit Liquidated(loanId, debt, take, surplus);
    }

    /**
     * @notice Returns collateral from a hold this pool escrows but never lent against.
     *
     * @dev Pledging and borrowing are two transactions. If the first lands and the second
     *      does not — the pool ran dry, the price moved, the relayer died — the borrower is
     *      left with their shares held and no loan to show for it. Every other release path
     *      here runs through a loan, so before this function there was nothing that could
     *      free those shares.
     *
     *      NOT permissionless, unlike `borrow`, `borrowFor` and `liquidate`. Those can be
     *      called by anyone because anyone calling them advances the borrower's own stated
     *      intent. This one is the opposite: releasing an unpledged hold *cancels* an intent,
     *      so leaving it open would let anyone front-run `borrowFor` and make every borrow
     *      fail, repeatedly and cheaply. Restricting it to the borrower and the admin closes
     *      that off without stranding anyone — see below.
     *
     *      Employees never pay gas, so they cannot call this themselves and the portal cannot
     *      relay it for them. That is a deliberate trade, not an oversight: the issuer can
     *      always recover on their behalf, and once the hold expires
     *      `reclaimHoldByPartition` on the token is permissionless and needs neither this
     *      pool nor anyone's permission. Nobody is ever permanently stuck; the worst case is
     *      waiting out the term.
     *
     * @param partition The partition the hold sits on.
     * @param borrower  The hold's owner. Collateral always returns to them, never to the caller.
     * @param holdId    Which of the borrower's holds to release.
     * @return released The amount handed back to the borrower's free balance.
     */
    function releaseUnusedHold(
        bytes32 partition,
        address borrower,
        uint256 holdId
    ) external nonReentrant returns (uint256 released) {
        if (msg.sender != borrower && msg.sender != admin) revert NotBorrower();

        // The guard that matters: this must not be collateral for a live loan.
        if (_pledged[keccak256(abi.encode(partition, borrower, holdId))]) {
            revert CollateralAlreadyPledged(holdId);
        }

        // Read raw rather than through `_readHold`. That helper reports a missing hold as
        // `PoolNotEscrow(0x0)`, because ATS deletes the record once a hold is fully released
        // and the escrow then reads as the zero address. For the lending paths that error is
        // right; here it would tell someone their pool is wrong when the truth is that there
        // is nothing left to recover.
        (uint256 collateral, uint256 expiry, address escrow, address destination, , , ) = esop.getHoldForByPartition(
            IHoldTypes.HoldIdentifier({ partition: partition, tokenHolder: borrower, holdId: holdId })
        );
        if (escrow == address(0) || collateral == 0) revert ZeroAmount();
        if (escrow != address(this)) revert PoolNotEscrow(escrow);
        if (destination != address(this)) revert PoolNotDestination(destination);

        // ATS refuses to release an expired hold — only the holder may reclaim it after that.
        // Say so plainly rather than letting the token revert with a bare selector, because
        // the remedy is a different call on a different contract.
        if (block.timestamp >= expiry) revert HoldExpiredUseReclaim(uint64(expiry));

        // No pool state to write first: `_pledged` is already false, which is this function's
        // precondition rather than something it clears. `nonReentrant` is the belt to CEI's
        // braces, since the token is an upgradeable diamond and could call back.
        if (
            !esop.releaseHoldByPartition(
                IHoldTypes.HoldIdentifier({ partition: partition, tokenHolder: borrower, holdId: holdId }),
                collateral
            )
        ) revert TokenCallFailed();

        emit UnusedHoldReleased(borrower, partition, holdId, collateral);
        return collateral;
    }

    // ------------------------------------------------------------------ views

    /**
     * @notice Debt including simple interest accrued to now.
     * @dev Simple rather than compounding, and computed on read rather than accrued into
     *      storage: a loan nobody touches costs nobody gas.
     */
    // slither-disable-next-line timestamp
    // Interest, maturity and staleness are all inherently time-based. Validator-scale drift
    // is seconds against terms measured in days.
    function debtOf(uint256 loanId) public view returns (uint256) {
        Loan storage loan = _loans[loanId];
        if (loan.status != LoanStatus.Active) return 0;
        uint256 elapsed = block.timestamp - loan.openedAt;
        uint256 interest = (loan.principal * loan.aprBps * elapsed) / (10_000 * 365 days);
        uint256 gross = loan.principal + interest;
        return gross > loan.repaid ? gross - loan.repaid : 0;
    }

    /**
     * @notice Value of `tokens` ESOP shares, in the stablecoin's decimals.
     * @dev Reads both feeds and refuses either if stale. The stablecoin leg is not
     *      decoration: if USDC is worth $0.90, a borrower repaying "1,000 USDC" is repaying
     *      $900 of value, and pricing collateral as though it were $1,000 quietly
     *      under-collateralises every loan on the book.
     */
    function collateralValue(uint256 tokens) public view returns (uint256) {
        (int256 nav, ) = _readFeed(navFeed, navMaxAge);
        (int256 peg, uint8 pegDecimals) = _readFeed(stableFeed, stableMaxAge);

        // A depeg beyond ±2% stops new borrowing rather than silently mispricing it.
        int256 one = int256(10 ** uint256(pegDecimals));
        if (peg < (one * 98) / 100 || peg > (one * 102) / 100) revert StablecoinDepegged(peg);

        uint8 navDecimals = navFeed.decimals();
        // One division, at the end. Splitting this into two steps loses precision on the
        // intermediate result, which on a large position is real money rather than dust.
        return
            (tokens * uint256(nav) * (10 ** uint256(_stableDecimals)) * uint256(one)) /
            ((10 ** uint256(navDecimals)) * uint256(peg));
    }

    /**
     * @notice Current loan-to-value in basis points. Above `liquidationLtvBps` it is seizable.
     *
     * @dev Two return values need reading carefully. Zero means the loan is not active — NOT
     *      that it is perfectly healthy — so check `status` before treating a low number as
     *      good news. `type(uint256).max` means the collateral currently values at nothing,
     *      which is a broken or unpublished feed far more often than a genuinely worthless
     *      grant, and it makes the loan liquidatable, so a UI should say "price unavailable"
     *      rather than render an infinite bar.
     *
     *      Recomputed live from the hold's CURRENT amount and the CURRENT price, never from
     *      anything stored at borrow time. A stock split doubles the shares under the hold,
     *      and reading a stored figure would under-collateralise the loan exactly then.
     */
    function ltvOf(uint256 loanId) external view returns (uint256) {
        Loan storage loan = _loans[loanId];
        if (loan.status != LoanStatus.Active) return 0;
        (uint256 collateral, ) = _readHold(loan.partition, loan.borrower, loan.holdId);
        uint256 value = collateralValue(collateral);
        if (value == 0) return type(uint256).max;
        return (debtOf(loanId) * 10_000) / value;
    }

    /**
     * @notice The whole loan record: borrower, collateral hold, principal, repayments, dates.
     * @dev Returns a zeroed struct with `status == None` for an unknown id rather than
     *      reverting. `principal` and `repaid` are in the stablecoin's decimals; the accrued
     *      interest is not stored, so read `debtOf` for what is actually owed today.
     */
    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return _loans[loanId];
    }

    /**
     * @notice Every loan id this borrower has ever opened, including repaid and liquidated ones.
     * @dev Append-only, so it doubles as a borrowing history. A UI listing live positions has
     *      to filter on `status`, not assume the array holds only open loans.
     */
    function loansOf(address borrower) external view returns (uint256[] memory) {
        return _loansOf[borrower];
    }

    /**
     * @notice Stablecoin on hand and lendable right now.
     * @dev The pool's actual balance, not a computed figure — it does not net out what
     *      outstanding loans will repay later, and it does not reserve anything. A borrow
     *      larger than this reverts with `InsufficientLiquidity`.
     */
    function available() external view returns (uint256) {
        return stable.balanceOf(address(this));
    }

    // --------------------------------------------------------------- internal

    /**
     * @dev Releases the hold if it can still be released. ATS refuses BOTH execute and
     *      release once a hold has expired — only the holder may reclaim after that. So a
     *      borrower repaying a loan whose hold has lapsed would otherwise be unable to repay
     *      at all, which would be a trap of our own making. Repayment always succeeds; the
     *      collateral is simply theirs to reclaim directly.
     * @return released How much was handed back here, zero if the borrower must reclaim.
     */
    function _releaseIfPossible(Loan storage loan) private returns (uint256 released) {
        (uint256 collateral, uint64 expiry) = _readHold(loan.partition, loan.borrower, loan.holdId);
        _pledged[keccak256(abi.encode(loan.partition, loan.borrower, loan.holdId))] = false;
        if (collateral == 0 || block.timestamp >= expiry) return 0;
        // Checked for the same reason as in the vesting controller: ATS reverts rather than
        // returning false today, but it is an upgradeable diamond and this costs nothing.
        if (
            !esop.releaseHoldByPartition(
                IHoldTypes.HoldIdentifier({
                    partition: loan.partition,
                    tokenHolder: loan.borrower,
                    holdId: loan.holdId
                }),
                collateral
            )
        ) revert TokenCallFailed();
        return collateral;
    }

    function _requireActive(uint256 loanId) private view returns (Loan storage loan) {
        loan = _loans[loanId];
        if (loan.status == LoanStatus.None) revert UnknownLoan(loanId);
        if (loan.status != LoanStatus.Active) revert LoanNotActive(loanId);
    }

    /**
     * @dev Reads the hold's CURRENT amount, never a figure recorded when the loan opened.
     *      ATS scales holds by its adjust-balance factor, so after a stock split a stored
     *      number is stale — and valuing collateral from a stale number would
     *      under-collateralise every loan on the book at exactly the moment the shares
     *      became more numerous. Same trap that bit `clawback` in Phase 2.
     */
    function _readHold(
        bytes32 partition,
        address holder,
        uint256 holdId
    ) private view returns (uint256 amount, uint64 expiry) {
        (uint256 amount_, uint256 expiry_, address escrow_, address destination_, , , ) = esop.getHoldForByPartition(
            IHoldTypes.HoldIdentifier({partition: partition, tokenHolder: holder, holdId: holdId})
        );
        if (escrow_ != address(this)) revert PoolNotEscrow(escrow_);
        if (destination_ != address(this)) revert PoolNotDestination(destination_);
        return (amount_, uint64(expiry_));
    }

    function _readFeed(IAggregatorV3 feed, uint64 maxAge) private view returns (int256 answer, uint8 feedDecimals) {
        (, int256 answer_, , uint256 updatedAt, ) = feed.latestRoundData();
        if (answer_ <= 0) revert InvalidPrice(address(feed), answer_);
        if (block.timestamp > updatedAt + maxAge) revert StalePrice(address(feed), updatedAt, maxAge);
        return (answer_, feed.decimals());
    }
}
