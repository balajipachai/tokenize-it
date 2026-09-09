// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IAtsEsop, IMultisig} from "./interfaces/IAtsEsop.sol";

/**
 * @title ESOPVestingController
 * @notice Grants, vests and claws back tokenized employee stock options held as ATS locks.
 *
 * @dev The grant abstraction ATS does not have. Each vesting tranche is one ATS lock whose
 *      expiration is its vest date, so vesting is enforced by the token itself rather than by
 *      this contract: once a lock expires, `releaseByPartition` is permissionless and this
 *      controller is a convenience, not a dependency.
 *
 *      This contract HOLDS the option pool, because `transferAndLockByPartition` moves tokens
 *      from the caller. It therefore has to be onboarded on the token like any other holder
 *      (KYC + allowlist) and needs ROLE_LOCKER, ROLE_CONTROLLER, and — while partitions are
 *      protected — ROLE_WILD_CARD.
 *
 *      Funding is deliberately batched. A 37-tranche grant costs ~15.9M gas measured on Hedera
 *      testnet, against a 15M per-transaction ceiling, so tranches cannot all be locked in one
 *      call. `createGrant` records the schedule; `fundTranches` locks it in batches.
 */
contract ESOPVestingController {
    enum GrantStatus {
        None,
        Funding,
        Active,
        Terminated
    }

    enum LeaverType {
        None,
        Good,
        Bad
    }

    /// @dev Kept separate from GrantStatus rather than folded into it. "Terminated" and
    ///      "contested" are two facts about a grant, not one: a grant can be terminated and
    ///      undisputed, terminated and contested, or reinstated after a dispute succeeded.
    ///      Collapsing them would lose the distinction between "never contested" and
    ///      "contested and the employer won".
    enum DisputeState {
        None,
        Raised,
        Upheld,
        Overturned
    }

    struct Tranche {
        uint128 amount;
        uint64 vestsAt;
        uint32 lockId; // 0 until funded; ATS assigns ids from 1
        bool released;
        bool clawedBack;
    }

    struct Grant {
        address employee;
        bytes32 partition;
        uint128 totalAmount;
        uint128 fundedAmount;
        uint64 grantDate;
        /// @dev Vesting cutoff once the employee leaves. Zero while active.
        uint64 terminatedAt;
        uint32 fundedTranches;
        GrantStatus status;
        LeaverType leaver;
        DisputeState dispute;
        /// @dev Clawback is blocked until this passes, giving the employee time to contest.
        uint64 disputeDeadline;
        /// @dev Who terminated. Recorded so they cannot also judge the appeal.
        address terminatedBy;
    }

    IAtsEsop public immutable token;

    /// @dev Two roles is not enough to justify pulling in OpenZeppelin's AccessControl, whose
    ///      IAccessControl also collides with ATS's own by Hardhat artifact name. `admin` is a
    ///      single transferable owner, so it follows the Ownable2Step shape; `isGrantAdmin` is an
    ///      admin-managed roster, so it is a plain mapping.
    address public admin;
    address public pendingAdmin;
    mapping(address => bool) public isGrantAdmin;

    /// @dev Arbiters resolve contested terminations. Deliberately a separate roster from
    ///      grant admins: an appeal judged by the person who fired you is not an appeal.
    mapping(address => bool) public isArbiter;

    /// @dev May raise a dispute on an employee's behalf. Safe to delegate because raising
    ///      one can only ever DELAY a forfeiture, never cause or enlarge one — so a
    ///      misbehaving relayer inconveniences the employer, not the employee.
    mapping(address => bool) public isDisputeRelayer;

    /// @notice How long after termination a clawback must wait. Settable so a demo can use
    ///         seconds where a real deployment would use weeks.
    uint64 public disputeWindow;

    uint256 private _reentrancyStatus;

    uint256 public nextGrantId = 1;
    mapping(uint256 => Grant) private _grants;
    // slither-disable-next-line uninitialized-state
    // Mappings have no initialiser; every entry is written by createGrant before it is read.
    mapping(uint256 => Tranche[]) private _tranches;
    mapping(address => uint256[]) private _grantsOf;

    event GrantCreated(
        uint256 indexed grantId,
        address indexed employee,
        bytes32 indexed partition,
        uint256 totalAmount,
        uint256 trancheCount
    );
    event TranchesFunded(uint256 indexed grantId, uint256 fromIndex, uint256 toIndex, uint256 amount);
    event GrantActivated(uint256 indexed grantId);
    event TrancheVested(uint256 indexed grantId, address indexed employee, uint256 trancheIndex, uint256 amount);
    event GrantTerminated(uint256 indexed grantId, LeaverType leaver, uint64 effectiveAt, address indexed decidedBy);
    event ClawedBack(uint256 indexed grantId, uint256 trancheCount, uint256 amount);
    event PoolReturned(bytes32 indexed partition, address indexed to, uint256 amount);
    event AdminTransferStarted(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    event GrantAdminSet(address indexed account, bool enabled);
    event ArbiterSet(address indexed account, bool enabled);
    event DisputeRelayerSet(address indexed account, bool enabled);
    event DisputeWindowSet(uint64 seconds_);
    event DisputeRaised(uint256 indexed grantId, address indexed employee, address indexed raisedBy);
    event DisputeResolved(uint256 indexed grantId, bool upheld, address indexed arbiter);
    event GrantReinstated(uint256 indexed grantId);
    event TrancheAccelerated(uint256 indexed grantId, uint256 trancheIndex, uint64 from, uint64 to);

    error ScheduleLengthMismatch();
    error EmptySchedule();
    error ZeroAmount();
    error ZeroAddress();
    error TrancheDatesNotIncreasing(uint256 index);
    error VestDateInPast(uint256 index);
    error UnknownGrant(uint256 grantId);
    error GrantNotFunding(uint256 grantId);
    error GrantAlreadyTerminated(uint256 grantId);
    error EffectiveDateInFuture();
    error EffectiveDateBeforeGrant();
    error LockIdTooLarge(uint256 lockId);
    error NotAdmin();
    error NotGrantAdmin();
    error NotPendingAdmin();
    error GrantNotTerminated(uint256 grantId);
    error Reentrancy();
    error TokenCallFailed();
    error NotArbiter();
    error NotDisputeRaiser();
    error DisputeWindowOpen(uint64 until);
    error DisputeWindowClosed(uint64 closedAt);
    error DisputeAlreadyRaised();
    error DisputeUnresolved();
    error NoDisputeToResolve();
    error ArbiterCannotJudgeOwnDecision();
    error ArbiterMustBeMultisig(address account);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyGrantAdmin() {
        if (!isGrantAdmin[msg.sender]) revert NotGrantAdmin();
        _;
    }

    /// @dev CEI ordering is the primary defence in every function below; this is the second,
    ///      independent layer. The ATS token is a diamond that delegatecalls to ~100 facets, so
    ///      "the callee is trusted" is a weaker statement here than it looks.
    modifier nonReentrant() {
        if (_reentrancyStatus == 1) revert Reentrancy();
        _reentrancyStatus = 1;
        _;
        _reentrancyStatus = 0;
    }

    constructor(IAtsEsop _token, address _admin, uint64 _disputeWindow) {
        if (address(_token) == address(0) || _admin == address(0)) revert ZeroAddress();
        token = _token;
        admin = _admin;
        isGrantAdmin[_admin] = true;
        disputeWindow = _disputeWindow;
        emit AdminTransferred(address(0), _admin);
        emit GrantAdminSet(_admin, true);
        emit DisputeWindowSet(_disputeWindow);
    }

    /**
     * @notice Appoints or removes an arbiter. Arbiters must be multisigs.
     * @dev An appeal decided by one person's private key is not an appeal, so this rejects
     *      EOAs and any contract that cannot show a threshold of at least two. Checking
     *      `getThreshold()` is a real test rather than a gesture: Safe and its clones expose
     *      it, an EOA has no code to call, and a 1-of-1 fails the threshold.
     *
     *      What it cannot prove is who the owners are — a 2-of-2 held by one person would
     *      pass. That residue is governance, not something a contract can settle, and it is
     *      why the roster stays revocable by `admin` and every ruling is attributed.
     */
    function setArbiter(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        if (enabled) {
            if (account.code.length == 0) revert ArbiterMustBeMultisig(account);
            try IMultisig(account).getThreshold() returns (uint256 threshold) {
                if (threshold < 2) revert ArbiterMustBeMultisig(account);
            } catch {
                revert ArbiterMustBeMultisig(account);
            }
        }
        isArbiter[account] = enabled;
        emit ArbiterSet(account, enabled);
    }

    function setDisputeRelayer(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        isDisputeRelayer[account] = enabled;
        emit DisputeRelayerSet(account, enabled);
    }

    function setDisputeWindow(uint64 seconds_) external onlyAdmin {
        disputeWindow = seconds_;
        emit DisputeWindowSet(seconds_);
    }

    function setGrantAdmin(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        isGrantAdmin[account] = enabled;
        emit GrantAdminSet(account, enabled);
    }

    /// @notice Step one of a two-step admin handover. Nothing changes until `acceptAdmin`.
    /// @dev Two-step on purpose: this address can forfeit employee equity via `clawback`,
    ///      so a one-step transfer to a typo'd or unreachable address would be unrecoverable.
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

    // ---------------------------------------------------------------- granting

    /**
     * @notice Records a vesting schedule. Locks nothing yet — call `fundTranches` next.
     * @param amounts Tranche sizes, in token base units. The first is conventionally the cliff.
     * @param vestsAt Vest timestamps, strictly increasing. The first is the cliff date.
     */
    function createGrant(
        address employee,
        bytes32 partition,
        uint128[] calldata amounts,
        uint64[] calldata vestsAt
    ) external onlyGrantAdmin returns (uint256 grantId) {
        if (employee == address(0)) revert ZeroAddress();
        if (amounts.length != vestsAt.length) revert ScheduleLengthMismatch();
        if (amounts.length == 0) revert EmptySchedule();

        grantId = nextGrantId++;
        Tranche[] storage list = _tranches[grantId];

        uint128 total;
        uint64 previous;
        for (uint256 i; i < amounts.length; ++i) {
            if (amounts[i] == 0) revert ZeroAmount();
            if (vestsAt[i] <= block.timestamp) revert VestDateInPast(i);
            if (i > 0 && vestsAt[i] <= previous) revert TrancheDatesNotIncreasing(i);
            previous = vestsAt[i];
            total += amounts[i];
            list.push(Tranche({amount: amounts[i], vestsAt: vestsAt[i], lockId: 0, released: false, clawedBack: false}));
        }

        _grants[grantId] = Grant({
            employee: employee,
            partition: partition,
            totalAmount: total,
            fundedAmount: 0,
            grantDate: uint64(block.timestamp),
            terminatedAt: 0,
            fundedTranches: 0,
            status: GrantStatus.Funding,
            leaver: LeaverType.None,
            dispute: DisputeState.None,
            disputeDeadline: 0,
            terminatedBy: address(0)
        });
        _grantsOf[employee].push(grantId);

        emit GrantCreated(grantId, employee, partition, total, amounts.length);
    }

    /**
     * @notice Locks the next `maxCount` unfunded tranches onto the employee.
     * @dev Must be called repeatedly until the grant becomes Active. Batching is a hard
     *      requirement, not an optimisation — see the contract-level note on gas.
     */
    function fundTranches(
        uint256 grantId,
        uint32 maxCount
    ) external onlyGrantAdmin nonReentrant returns (uint32 funded) {
        Grant storage g = _requireGrant(grantId);
        if (g.status != GrantStatus.Funding) revert GrantNotFunding(grantId);

        Tranche[] storage list = _tranches[grantId];
        uint256 start = g.fundedTranches;
        uint256 end = start + maxCount;
        if (end > list.length) end = list.length;

        uint128 amountFunded;
        // slither-disable-next-line calls-loop
        // One lock per tranche is the design, and Hedera's 15M gas ceiling makes a single
        // batched call impossible. `maxCount` is the bound.
        for (uint256 i = start; i < end; ++i) {
            Tranche storage t = list[i];
            uint256 lockId = token.transferAndLockByPartition(
                g.partition,
                g.employee,
                t.amount,
                "",
                t.vestsAt
            );
            if (lockId > type(uint32).max) revert LockIdTooLarge(lockId);
            t.lockId = uint32(lockId);
            amountFunded += t.amount;
        }

        funded = uint32(end - start);
        g.fundedTranches = uint32(end);
        g.fundedAmount += amountFunded;
        emit TranchesFunded(grantId, start, end, amountFunded);

        if (end == list.length) {
            g.status = GrantStatus.Active;
            emit GrantActivated(grantId);
        }
    }

    // ----------------------------------------------------------------- vesting

    /**
     * @notice Releases every tranche that has vested. Permissionless by design.
     * @dev After termination the cutoff freezes at the leaving date, so tranches that would
     *      have vested afterwards stay locked and remain clawback-able.
     */
    function releaseVested(
        uint256 grantId,
        uint32 maxCount
    ) external nonReentrant returns (uint256 releasedAmount) {
        Grant storage g = _requireGrant(grantId);
        uint64 cutoff = _vestingCutoff(g);

        // Hoisted onto the stack: re-reading these from storage inside the loop costs a
        // warm SLOAD every iteration for values that cannot change during it.
        address employee = g.employee;
        bytes32 partition = g.partition;
        Tranche[] storage list = _tranches[grantId];
        uint256 len = list.length;

        uint32 done;
        // slither-disable-next-line calls-loop,timestamp
        // Bounded by `maxCount`. Vest dates are months apart, so the seconds of timestamp
        // drift a validator could induce cannot move a tranche across its boundary.
        for (uint256 i; i < len && done < maxCount; ++i) {
            // A Tranche is one packed slot, so this reads all five fields in a single
            // SLOAD instead of one per field. The mutation below still writes storage
            // directly -- copying the whole struct back would rewrite the fields we did
            // not touch.
            Tranche memory t = list[i];
            if (t.released || t.clawedBack || t.lockId == 0) continue;
            if (t.vestsAt > cutoff) continue;

            // Someone may have released this lock directly on the token; skip rather than revert.
            (uint256 lockedAmount, uint256 lockExpiry) = token.getLockForByPartition(partition, employee, t.lockId);
            if (lockedAmount == 0) {
                list[i].released = true;
                continue;
            }

            list[i].released = true; // effect before interaction
            // ATS returns true or reverts today, but it is an upgradeable diamond -- checking
            // costs nothing and stops a future silent `false` from marking a tranche released
            // without the tokens ever moving.
            if (lockExpiry > block.timestamp) {
                // Accelerated by a good-leaver termination: our record says this tranche is
                // credited, but the underlying lock still carries its original date. Only a
                // grant admin can create that state, so force-releasing here delegates no new
                // authority -- it just carries out a decision already made and recorded.
                if (!token.forceReleaseByPartition(partition, t.lockId, employee)) revert TokenCallFailed();
            } else if (!token.releaseByPartition(partition, t.lockId, employee)) {
                revert TokenCallFailed();
            }
            releasedAmount += lockedAmount;
            unchecked {
                ++done;
            }
            emit TrancheVested(grantId, employee, i, lockedAmount);
        }
    }

    // ----------------------------------------------------------------- leaving

    /**
     * @notice Marks the employee as having left. Moves no tokens.
     *
     * @dev `leaver` and `effectiveAt` are taken as explicit parameters because no on-chain fact
     *      can establish whether somebody resigned, was dismissed for cause, or which day was
     *      their last — employment ends off-chain, in an HR system. Pretending otherwise would
     *      be fake trustlessness. The mitigations are procedural rather than cryptographic:
     *      every termination is permanently attributed to `msg.sender` in `GrantTerminated`,
     *      the grant-admin role is revocable by `admin` via `setGrantAdmin`, and the effective
     *      date cannot be pushed into the future to manufacture extra vesting.
     *
     * @param effectiveAt Leaving date, which becomes the vesting cutoff. May be back-dated to
     *        the real last working day, but never forward-dated.
     */
    function terminate(
        uint256 grantId,
        LeaverType leaver,
        uint64 effectiveAt
    ) external onlyGrantAdmin {
        Grant storage g = _requireGrant(grantId);
        if (g.status == GrantStatus.Terminated) revert GrantAlreadyTerminated(grantId);
        if (effectiveAt > block.timestamp) revert EffectiveDateInFuture();
        if (effectiveAt < g.grantDate) revert EffectiveDateBeforeGrant();

        g.status = GrantStatus.Terminated;
        g.terminatedAt = effectiveAt;
        g.leaver = leaver;
        g.dispute = DisputeState.None;
        g.disputeDeadline = uint64(block.timestamp) + disputeWindow;
        g.terminatedBy = msg.sender;

        // A good leaver is credited the tranche they were part-way through. Implemented by
        // pulling that tranche's vest date back to the leaving date, so it simply falls
        // inside the existing cutoff rather than needing a parallel "accelerated" concept.
        if (leaver == LeaverType.Good) {
            Tranche[] storage list = _tranches[grantId];
            for (uint256 i; i < list.length; ++i) {
                if (list[i].released || list[i].clawedBack) continue;
                if (list[i].vestsAt > effectiveAt) {
                    emit TrancheAccelerated(grantId, i, list[i].vestsAt, effectiveAt);
                    list[i].vestsAt = effectiveAt;
                    break;
                }
            }
        }

        emit GrantTerminated(grantId, leaver, effectiveAt, msg.sender);
    }

    /**
     * @notice Contests a termination, blocking clawback until an arbiter rules.
     * @dev Callable by the employee, or by a dispute relayer on their behalf — the employee
     *      holds equity on an account that may never have paid gas, so requiring them to
     *      transact would make the right theoretical only. Delegating is safe because raising
     *      a dispute can only delay a forfeiture, never cause one.
     */
    function raiseDispute(uint256 grantId) external {
        Grant storage g = _requireGrant(grantId);
        if (msg.sender != g.employee && !isDisputeRelayer[msg.sender]) revert NotDisputeRaiser();
        if (g.status != GrantStatus.Terminated) revert GrantNotTerminated(grantId);
        if (g.dispute != DisputeState.None) revert DisputeAlreadyRaised();
        if (block.timestamp > g.disputeDeadline) revert DisputeWindowClosed(g.disputeDeadline);

        g.dispute = DisputeState.Raised;
        emit DisputeRaised(grantId, g.employee, msg.sender);
    }

    /**
     * @notice Rules on a contested termination.
     * @dev `upheld` is a parameter for the same reason the leaver type is: no on-chain fact can
     *      establish whether a dismissal was fair. The mitigations are procedural — the ruling
     *      is attributed to `msg.sender`, the arbiter roster is revocable by `admin`, and the
     *      address that terminated the grant is barred from judging the appeal.
     */
    function resolveDispute(uint256 grantId, bool upheld) external {
        Grant storage g = _requireGrant(grantId);
        if (!isArbiter[msg.sender]) revert NotArbiter();
        if (msg.sender == g.terminatedBy) revert ArbiterCannotJudgeOwnDecision();
        if (g.dispute != DisputeState.Raised) revert NoDisputeToResolve();

        if (upheld) {
            g.dispute = DisputeState.Upheld;
        } else {
            // The termination is undone: vesting resumes from where it was frozen.
            g.dispute = DisputeState.Overturned;
            g.status = GrantStatus.Active;
            g.terminatedAt = 0;
            g.leaver = LeaverType.None;
            emit GrantReinstated(grantId);
        }
        emit DisputeResolved(grantId, upheld, msg.sender);
    }

    /**
     * @notice Force-releases unvested tranches after termination and returns them to the pool.
     * @dev Force-release and recovery happen in the same call on purpose: force-release moves tokens
     *      into the employee's free balance, and leaving them there across transactions would be
     *      a window in which they are neither vested nor recoverable.
     */
    function clawback(
        uint256 grantId,
        uint32 maxCount
    ) external onlyGrantAdmin nonReentrant returns (uint256 forfeited) {
        Grant storage g = _requireGrant(grantId);
        if (g.status != GrantStatus.Terminated) revert GrantNotTerminated(grantId);

        // The dispute window is a real timeout, not just a stored field: this is the
        // reachable trigger that enforces it. An undisputed termination waits it out; a
        // contested one waits for a ruling; an upheld ruling proceeds immediately.
        if (g.dispute == DisputeState.Raised) revert DisputeUnresolved();
        if (g.dispute == DisputeState.None && block.timestamp <= g.disputeDeadline) {
            revert DisputeWindowOpen(g.disputeDeadline);
        }

        address employee = g.employee;
        bytes32 partition = g.partition;
        uint64 cutoff = g.terminatedAt;
        Tranche[] storage list = _tranches[grantId];
        uint256 len = list.length;

        uint32 done;
        uint256 count;
        // slither-disable-next-line calls-loop,timestamp
        // Bounded by `maxCount`; the cutoff is a stored leaving date, not block.timestamp.
        for (uint256 i; i < len && done < maxCount; ++i) {
            Tranche memory t = list[i]; // one packed slot, one SLOAD
            if (t.released || t.clawedBack || t.lockId == 0) continue;
            if (t.vestsAt <= cutoff) continue; // vested before leaving -- the employee keeps it

            // Recover what the token says is locked NOW, not the amount recorded at grant
            // time. ATS scales locks by the adjust-balance factor, so after a stock split the
            // two diverge -- and moving the stale, smaller number would leave the employee
            // holding unvested equity they had already forfeited.
            (uint256 lockedAmount, ) = token.getLockForByPartition(partition, employee, t.lockId);
            if (lockedAmount == 0) {
                list[i].clawedBack = true;
                continue;
            }

            list[i].clawedBack = true; // effect before interaction
            if (!token.forceReleaseByPartition(partition, t.lockId, employee)) revert TokenCallFailed();
            forfeited += lockedAmount;
            ++count;
            unchecked {
                ++done;
            }
        }

        if (forfeited > 0) {
            // Returned to this contract's pool rather than burned. Forfeited options are meant
            // to become grantable again, and a transfer does that directly -- burning would
            // drop total supply and need a fresh mint (and ISSUER_ROLE) to reuse them.
            token.controllerTransferByPartition(partition, employee, address(this), forfeited, "", "");
            emit ClawedBack(grantId, count, forfeited);
        }
    }

    // --------------------------------------------------------------- treasury

    /// @notice Returns unallocated pool tokens from this contract to the treasury.
    function returnToTreasury(
        bytes32 partition,
        address to,
        uint256 amount
    ) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        // slither-disable-next-line unused-return
        // transferByPartition returns the partition key, not a success flag; it reverts on failure.
        token.transferByPartition(partition, IAtsEsop.BasicTransferInfo({to: to, value: amount}), "");
        emit PoolReturned(partition, to, amount);
    }

    // ------------------------------------------------------------------ views

    function getGrant(uint256 grantId) external view returns (Grant memory) {
        return _grants[grantId];
    }

    function getTranches(uint256 grantId) external view returns (Tranche[] memory) {
        return _tranches[grantId];
    }

    function grantsOf(address employee) external view returns (uint256[] memory) {
        return _grantsOf[employee];
    }

    /// @notice Amount that has vested, whether or not it has been released yet.
    function vestedAmount(uint256 grantId) external view returns (uint256 amount) {
        Grant storage g = _grants[grantId];
        uint64 cutoff = _vestingCutoff(g);
        Tranche[] storage list = _tranches[grantId];
        for (uint256 i; i < list.length; ++i) {
            if (list[i].clawedBack) continue;
            if (list[i].vestsAt <= cutoff) amount += list[i].amount;
        }
    }

    /// @notice Amount still subject to forfeiture.
    function unvestedAmount(uint256 grantId) external view returns (uint256 amount) {
        Grant storage g = _grants[grantId];
        uint64 cutoff = _vestingCutoff(g);
        Tranche[] storage list = _tranches[grantId];
        for (uint256 i; i < list.length; ++i) {
            if (list[i].clawedBack) continue;
            if (list[i].vestsAt > cutoff) amount += list[i].amount;
        }
    }

    /**
     * @notice Amount forfeited and returned to the pool.
     * @dev Without this the figures do not reconcile: `vestedAmount` and `unvestedAmount`
     *      both skip clawed-back tranches, so after a forfeiture they no longer sum to
     *      `totalAmount` and the difference has no name. This is that difference.
     *      The identity `granted == vested + unvested + clawedBack` holds by construction.
     */
    function clawedBackAmount(uint256 grantId) external view returns (uint256 amount) {
        Tranche[] storage list = _tranches[grantId];
        for (uint256 i; i < list.length; ++i) {
            if (list[i].clawedBack) amount += list[i].amount;
        }
    }

    /// @notice Timestamp of the next tranche to vest, or 0 if fully vested or terminated.
    function nextVestAt(uint256 grantId) external view returns (uint64) {
        Grant storage g = _grants[grantId];
        if (g.status == GrantStatus.Terminated) return 0;
        Tranche[] storage list = _tranches[grantId];
        for (uint256 i; i < list.length; ++i) {
            if (list[i].vestsAt > block.timestamp) return list[i].vestsAt;
        }
        return 0;
    }

    function pendingTranches(uint256 grantId) external view returns (uint256 count) {
        Grant storage g = _grants[grantId];
        uint64 cutoff = _vestingCutoff(g);
        Tranche[] storage list = _tranches[grantId];
        for (uint256 i; i < list.length; ++i) {
            Tranche storage t = list[i];
            if (t.released || t.clawedBack || t.lockId == 0) continue;
            if (t.vestsAt <= cutoff) ++count;
        }
    }

    // --------------------------------------------------------------- internal

    function _requireGrant(uint256 grantId) private view returns (Grant storage g) {
        g = _grants[grantId];
        if (g.status == GrantStatus.None) revert UnknownGrant(grantId);
    }

    function _vestingCutoff(Grant storage g) private view returns (uint64) {
        return g.terminatedAt == 0 ? uint64(block.timestamp) : g.terminatedAt;
    }
}
