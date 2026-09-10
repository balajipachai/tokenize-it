// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @title IHederaScheduleService
 * @notice The slice of Hedera's Schedule Service system contract (HIP-1215) that vesting uses.
 *
 * @dev Lives natively at `0x16b` — address 363. It is implemented in the consensus node, NOT
 *      as EVM bytecode, so `eth_getCode` returns `0x` and it looks unavailable. It is not.
 *      Probe it by CALLING a view function; `hasScheduleCapacity` is the cheap one.
 *
 *      What this buys: a scheduled call executes on Hedera's own clock. No keeper holds the
 *      responsibility for a vest happening on time, and no trusted party can withhold it.
 *      Anyone may schedule and pay — the call itself is permissionless either way, since
 *      `releaseVested` can be triggered by anybody once a tranche's date has passed.
 *
 *      HIP-423 caps a schedule's expiry at 62 days, so a four-year vesting schedule cannot be
 *      armed up front. Arm the NEXT tranche and roll forward. A missed roll must be
 *      recoverable, which is why the keeper fallback exists and why release stays
 *      permissionless: automation is convenience here, never correctness.
 */
interface IHederaScheduleService {
    /**
     * @notice Schedules `callData` to be executed against `to` at `expirySecond`.
     * @param to The contract to call when the schedule fires.
     * @param expirySecond Consensus second at which to execute. At most 62 days out.
     * @param gasLimit Gas to make available to the scheduled call.
     * @param value Tinybar to send with the scheduled call.
     * @param callData ABI-encoded call to execute.
     * @return responseCode Hedera response code; 22 is SUCCESS.
     * @return scheduleAddress The created schedule, addressable for inspection or deletion.
     */
    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes calldata callData
    ) external payable returns (int64 responseCode, address scheduleAddress);

    /// @notice Whether the network has room to schedule `gasLimit` at `expirySecond`.
    /// @dev Also the safe way to check the system contract is live, since it has no bytecode.
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool);

    /// @notice Cancels a schedule that has not yet executed.
    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);
}
