// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IAtsEsop} from "./interfaces/IAtsEsop.sol";

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
    }

    IAtsEsop public immutable token;

    /// @dev Two roles is not enough to justify pulling in OpenZeppelin's AccessControl,
    ///      whose IAccessControl also collides with ATS's own by artifact name.
    address public admin;
    mapping(address => bool) public isGrantAdmin;

    uint256 public nextGrantId = 1;
    mapping(uint256 => Grant) private _grants;
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
    event GrantTerminated(uint256 indexed grantId, LeaverType leaver, uint64 effectiveAt);
    event ClawedBack(uint256 indexed grantId, uint256 trancheCount, uint256 amount);
    event PoolReturned(bytes32 indexed partition, address indexed to, uint256 amount);
    event AdminTransferred(address indexed from, address indexed to);
    event GrantAdminSet(address indexed account, bool enabled);

    error ScheduleLengthMismatch();
    error EmptySchedule();
    error ZeroAmount();
    error ZeroAddress();
    error TrancheDatesNotIncreasing(uint256 index);
    error VestDateInPast(uint256 index);
    error UnknownGrant(uint256 grantId);
    error GrantNotFunding(uint256 grantId);
    error GrantNotActive(uint256 grantId);
    error GrantAlreadyTerminated(uint256 grantId);
    error EffectiveDateInFuture();
    error EffectiveDateBeforeGrant();
    error LockIdTooLarge(uint256 lockId);
    error NotAdmin();
    error NotGrantAdmin();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyGrantAdmin() {
        if (!isGrantAdmin[msg.sender]) revert NotGrantAdmin();
        _;
    }

    constructor(IAtsEsop _token, address _admin) {
        if (address(_token) == address(0) || _admin == address(0)) revert ZeroAddress();
        token = _token;
        admin = _admin;
        isGrantAdmin[_admin] = true;
        emit AdminTransferred(address(0), _admin);
        emit GrantAdminSet(_admin, true);
    }

    function setGrantAdmin(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        isGrantAdmin[account] = enabled;
        emit GrantAdminSet(account, enabled);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
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
            leaver: LeaverType.None
        });
        _grantsOf[employee].push(grantId);

        emit GrantCreated(grantId, employee, partition, total, amounts.length);
    }

    /**
     * @notice Locks the next `maxCount` unfunded tranches onto the employee.
     * @dev Must be called repeatedly until the grant becomes Active. Batching is a hard
     *      requirement, not an optimisation — see the contract-level note on gas.
     */
    function fundTranches(uint256 grantId, uint32 maxCount) external onlyGrantAdmin returns (uint32 funded) {
        Grant storage g = _requireGrant(grantId);
        if (g.status != GrantStatus.Funding) revert GrantNotFunding(grantId);

        Tranche[] storage list = _tranches[grantId];
        uint256 start = g.fundedTranches;
        uint256 end = start + maxCount;
        if (end > list.length) end = list.length;

        uint128 amountFunded;
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
    function releaseVested(uint256 grantId, uint32 maxCount) external returns (uint256 releasedAmount) {
        Grant storage g = _requireGrant(grantId);
        uint64 cutoff = _vestingCutoff(g);

        Tranche[] storage list = _tranches[grantId];
        uint32 done;
        for (uint256 i; i < list.length && done < maxCount; ++i) {
            Tranche storage t = list[i];
            if (t.released || t.clawedBack || t.lockId == 0) continue;
            if (t.vestsAt > cutoff) continue;

            // Someone may have released this lock directly on the token; skip rather than revert.
            (uint256 lockedAmount, ) = token.getLockForByPartition(g.partition, g.employee, t.lockId);
            if (lockedAmount == 0) {
                t.released = true;
                continue;
            }

            token.releaseByPartition(g.partition, t.lockId, g.employee);
            t.released = true;
            releasedAmount += t.amount;
            unchecked {
                ++done;
            }
            emit TrancheVested(grantId, g.employee, i, t.amount);
        }
    }

    // ----------------------------------------------------------------- leaving

    /**
     * @notice Marks the employee as having left. Moves no tokens.
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
        emit GrantTerminated(grantId, leaver, effectiveAt);
    }

    /**
     * @notice Force-releases and burns unvested tranches after termination.
     * @dev Force-release and burn happen in the same call on purpose: force-release moves tokens
     *      into the employee's free balance, and leaving them there across transactions would be
     *      a window in which they are neither vested nor recoverable.
     */
    function clawback(uint256 grantId, uint32 maxCount) external onlyGrantAdmin returns (uint256 burned) {
        Grant storage g = _requireGrant(grantId);
        if (g.status != GrantStatus.Terminated) revert GrantNotActive(grantId);

        Tranche[] storage list = _tranches[grantId];
        uint32 done;
        uint256 count;
        for (uint256 i; i < list.length && done < maxCount; ++i) {
            Tranche storage t = list[i];
            if (t.released || t.clawedBack || t.lockId == 0) continue;
            if (t.vestsAt <= g.terminatedAt) continue; // vested before leaving -- the employee keeps it

            (uint256 lockedAmount, ) = token.getLockForByPartition(g.partition, g.employee, t.lockId);
            if (lockedAmount == 0) {
                t.clawedBack = true;
                continue;
            }

            token.forceReleaseByPartition(g.partition, t.lockId, g.employee);
            t.clawedBack = true;
            burned += t.amount;
            ++count;
            unchecked {
                ++done;
            }
        }

        if (burned > 0) {
            token.controllerRedeemByPartition(g.partition, g.employee, burned, "", "");
            emit ClawedBack(grantId, count, burned);
        }
    }

    // --------------------------------------------------------------- treasury

    /// @notice Returns unallocated pool tokens from this contract to the treasury.
    function returnToTreasury(
        bytes32 partition,
        address to,
        uint256 amount
    ) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
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
