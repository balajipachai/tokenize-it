// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

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
contract ESOPLendingPool {
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

    IAtsEsop public immutable esop;
    IERC20Minimal public immutable stable;
    uint8 private immutable _stableDecimals;

    address public admin;
    address public pendingAdmin;

    /// @notice Price per ESOP share. Chainlink-shaped, so a listed issuer swaps in a real feed.
    IAggregatorV3 public navFeed;
    /// @notice Stablecoin peg feed. A depeg silently inflates what a borrower actually owes.
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
    error Reentrancy();
    error TransferFailed();
    error TokenCallFailed();
    error NoRequestedAmount();

    uint256 private _entered;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @dev CEI ordering is the primary defence throughout; this is the second layer.
    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    /// @dev One live loan per hold. Without this, the same collateral could back several.
    mapping(bytes32 => bool) private _pledged;

    constructor(IAtsEsop _esop, IERC20Minimal _stable, uint8 stableDecimals_, address _admin) {
        if (address(_esop) == address(0) || address(_stable) == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }
        esop = _esop;
        stable = _stable;
        _stableDecimals = stableDecimals_;
        admin = _admin;

        maxLtvBps = 2_500; // 25% — an illiquid, appraisal-priced asset does not support more
        liquidationLtvBps = 4_000;
        aprBps = 800;
        minTerm = 7 days;
        maxTerm = 730 days;
        liquidationGrace = 3 days;
        navMaxAge = 400 days; // an appraisal is annual; "stale" is its normal condition
        stableMaxAge = 2 days;

        emit AdminTransferred(address(0), _admin);
        emit RiskParamsSet(maxLtvBps, liquidationLtvBps, aprBps, minTerm, maxTerm);
    }

    // ------------------------------------------------------------------ admin

    function setFeeds(
        IAggregatorV3 _navFeed,
        IAggregatorV3 _stableFeed,
        uint64 _navMaxAge,
        uint64 _stableMaxAge
    ) external onlyAdmin {
        navFeed = _navFeed;
        stableFeed = _stableFeed;
        navMaxAge = _navMaxAge;
        stableMaxAge = _stableMaxAge;
        emit FeedsSet(address(_navFeed), address(_stableFeed), _navMaxAge, _stableMaxAge);
    }

    function setRiskParams(
        uint16 _maxLtvBps,
        uint16 _liquidationLtvBps,
        uint16 _aprBps,
        uint64 _minTerm,
        uint64 _maxTerm,
        uint64 _liquidationGrace
    ) external onlyAdmin {
        // A grace longer than the shortest term would put maturity before the loan opened.
        if (_liquidationGrace >= _minTerm) revert GraceExceedsMinTerm(_liquidationGrace, _minTerm);
        maxLtvBps = _maxLtvBps;
        liquidationLtvBps = _liquidationLtvBps;
        aprBps = _aprBps;
        minTerm = _minTerm;
        maxTerm = _maxTerm;
        liquidationGrace = _liquidationGrace;
        emit RiskParamsSet(_maxLtvBps, _liquidationLtvBps, _aprBps, _minTerm, _maxTerm);
    }

    function addLiquidity(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (!stable.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit LiquidityAdded(msg.sender, amount);
    }

    function removeLiquidity(address to, uint256 amount) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        emit LiquidityRemoved(to, amount);
        if (!stable.transfer(to, amount)) revert TransferFailed();
    }

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

    /// @notice Current loan-to-value in basis points. Above `liquidationLtvBps` it is seizable.
    function ltvOf(uint256 loanId) external view returns (uint256) {
        Loan storage loan = _loans[loanId];
        if (loan.status != LoanStatus.Active) return 0;
        (uint256 collateral, ) = _readHold(loan.partition, loan.borrower, loan.holdId);
        uint256 value = collateralValue(collateral);
        if (value == 0) return type(uint256).max;
        return (debtOf(loanId) * 10_000) / value;
    }

    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return _loans[loanId];
    }

    function loansOf(address borrower) external view returns (uint256[] memory) {
        return _loansOf[borrower];
    }

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
