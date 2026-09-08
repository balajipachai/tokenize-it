// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @notice The slice of the ATS security-token diamond that ESOPVestingController uses.
 * @dev Declared locally rather than importing IAsset so the controller compiles against a
 *      stable, reviewable surface instead of ~100 facets. Signatures verified against
 *      packages/ats/contracts/contracts/facets in the pinned ATS revision.
 */
interface IAtsEsop {
    /// @dev Caller must hold the tokens and ROLE_LOCKER. Moves `amount` from the caller to
    ///      `to` and locks it until `expirationTimestamp`.
    function transferAndLockByPartition(
        bytes32 partition,
        address to,
        uint256 amount,
        bytes calldata data,
        uint256 expirationTimestamp
    ) external returns (uint256 lockId);

    /// @dev Permissionless once the lock has expired.
    function releaseByPartition(bytes32 partition, uint256 lockId, address tokenHolder) external returns (bool);

    /// @dev Skips the expiration check. Requires ROLE_LOCKER or ROLE_CONTROLLER.
    function forceReleaseByPartition(bytes32 partition, uint256 lockId, address tokenHolder) external returns (bool);

    /// @dev Burns from `tokenHolder`'s free balance. Requires ROLE_CONTROLLER and a controllable token.
    ///      Cannot reach locked or held tokens, so force-release must come first.
    function controllerRedeemByPartition(
        bytes32 partition,
        address tokenHolder,
        uint256 value,
        bytes calldata data,
        bytes calldata operatorData
    ) external;

    function transferByPartition(
        bytes32 partition,
        BasicTransferInfo calldata transferInfo,
        bytes calldata data
    ) external returns (bytes32);

    function getLockForByPartition(
        bytes32 partition,
        address tokenHolder,
        uint256 lockId
    ) external view returns (uint256 amount, uint256 expirationTimestamp);

    function balanceOfByPartition(bytes32 partition, address tokenHolder) external view returns (uint256);

    function getLockedAmountForByPartition(bytes32 partition, address tokenHolder) external view returns (uint256);

    struct BasicTransferInfo {
        address to;
        uint256 value;
    }
}
