// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IHederaScheduleService} from "../interfaces/IHederaScheduleService.sol";

/**
 * @title VestingScheduler
 * @notice Arms a grant's next vest on Hedera's own clock, so nobody has to remember.
 *
 * @dev WHY THIS CONTRACT EXISTS AT ALL. `scheduleCall` on the Schedule Service (HIP-1215)
 *      cannot be invoked from an externally-owned account: an EOA calling it reverts with
 *      INVALID_CONTRACT_ID, having consumed the whole gas limit, even though `eth_call`
 *      simulates the same call successfully. Scheduling has to originate from contract code.
 *      Putting that here rather than inside ESOPVestingController keeps the controller —
 *      which holds every grant and the entire option pool — untouched and un-redeployed.
 *
 *      WHAT IT DOES NOT DO, deliberately:
 *
 *      It holds no funds. `arm` is payable and forwards exactly what the caller sent, so
 *      there is no balance for anyone to drain by arming repeatedly. A scheduler that paid
 *      for its own schedules would be a free-gas faucet for whoever called it in a loop.
 *
 *      It has no privileges over the controller. The call it schedules is `releaseVested`,
 *      which is already permissionless — anyone may trigger a vest once its date has passed.
 *      So this contract cannot cause anything that could not already happen; it only decides
 *      WHEN somebody stops having to do it by hand.
 *
 *      It is not load-bearing. Vesting is correct with zero automation, because the ATS lock's
 *      expiry is the source of truth and release is permissionless. If a schedule never fires,
 *      the employee still claims. That is the property worth protecting, and it is why this
 *      contract is allowed to be simple.
 *
 *      HIP-423 caps a schedule at 62 days, so a four-year schedule cannot be armed up front.
 *      Arm the next tranche and roll forward on each release.
 *
 *      STATUS ON TESTNET, stated plainly so nobody debugs this for an afternoon: `arm`
 *      currently FAILS on Hedera testnet. `scheduleCall` returns INVALID_CONTRACT_ID for
 *      every target we tried, from an EOA and from contract code alike, while
 *      `hasScheduleCapacity` on the same system contract answers true — so the service is
 *      reachable and the scheduling call itself is not yet usable there. Nothing in this
 *      contract is wrong as far as we can tell; the network side is not ready.
 *
 *      This costs nothing, which was the design goal. Because release is permissionless and
 *      the lock's expiry is the real source of truth, the keeper in
 *      `scripts/testnet-vesting-keeper.ts` delivers the same outcome, and vesting is correct
 *      either way. Automation here is convenience, never correctness.
 */
contract VestingScheduler {
    /// @notice Hedera's Schedule Service, native at address 363. It has no EVM bytecode.
    IHederaScheduleService public constant SCHEDULE_SERVICE =
        IHederaScheduleService(0x000000000000000000000000000000000000016B);

    /// @dev HIP-423. A schedule further out than this is rejected by the network.
    uint256 public constant MAX_SCHEDULE_AHEAD = 62 days;

    /// @dev Hedera's SUCCESS response code.
    int64 private constant SUCCESS = 22;

    event VestArmed(
        address indexed controller,
        uint256 indexed grantId,
        uint256 vestsAt,
        address schedule,
        address indexed armedBy
    );

    error ScheduleInThePast(uint256 vestsAt);
    error ScheduleTooFarOut(uint256 vestsAt, uint256 latest);
    error NoCapacity(uint256 vestsAt, uint256 gasLimit);
    error ScheduleFailed(int64 responseCode);

    /**
     * @notice Schedules `releaseVested(grantId, maxCount)` on `controller` at `vestsAt`.
     *
     * @dev Permissionless, because what it schedules is permissionless. The caller pays: the
     *      HBAR sent with this call funds the scheduled execution, and nothing is retained.
     *
     * @param controller The ESOPVestingController holding the grant.
     * @param grantId    Grant whose next tranche is being armed.
     * @param maxCount   Tranche cap passed through to `releaseVested`, bounding its work.
     * @param vestsAt    Consensus second the tranche becomes claimable.
     * @param gasLimit   Gas to make available to the scheduled call.
     * @return schedule  The created schedule, addressable for inspection.
     */
    function arm(
        address controller,
        uint256 grantId,
        uint32 maxCount,
        uint256 vestsAt,
        uint256 gasLimit
    ) external payable returns (address schedule) {
        if (vestsAt <= block.timestamp) revert ScheduleInThePast(vestsAt);
        if (vestsAt > block.timestamp + MAX_SCHEDULE_AHEAD) {
            revert ScheduleTooFarOut(vestsAt, block.timestamp + MAX_SCHEDULE_AHEAD);
        }
        if (!SCHEDULE_SERVICE.hasScheduleCapacity(vestsAt, gasLimit)) revert NoCapacity(vestsAt, gasLimit);

        bytes memory callData = abi.encodeWithSignature("releaseVested(uint256,uint32)", grantId, maxCount);

        int64 responseCode;
        (responseCode, schedule) = SCHEDULE_SERVICE.scheduleCall{value: msg.value}(
            controller,
            vestsAt,
            gasLimit,
            0,
            callData
        );
        if (responseCode != SUCCESS) revert ScheduleFailed(responseCode);

        emit VestArmed(controller, grantId, vestsAt, schedule, msg.sender);
    }

    /// @notice Whether the network can take a schedule of this size at this time.
    /// @dev Exposed because the system contract has no bytecode, so callers cannot probe it
    ///      by checking for code — a view call is the only honest liveness check.
    function hasCapacity(uint256 vestsAt, uint256 gasLimit) external view returns (bool) {
        return SCHEDULE_SERVICE.hasScheduleCapacity(vestsAt, gasLimit);
    }
}
