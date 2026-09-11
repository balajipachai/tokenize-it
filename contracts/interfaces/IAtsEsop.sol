// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @notice The slice of the ATS security-token diamond that ESOPVestingController uses.
 * @dev Declared locally rather than importing IAsset so the controller compiles against a
 *      stable, reviewable surface instead of ~100 facets. Signatures verified against
 *      packages/ats/contracts/contracts/facets in the pinned ATS revision.
 */
/**
 * @notice The slice of a Safe-style multisig used to check an arbiter is genuinely one.
 * @dev Only `getThreshold` is needed. Safe and its clones expose it; a plain EOA cannot.
 */
interface IMultisig {
    /// @dev Signatures required to act. Used as proof of multi-party control: an EOA has no
    ///      code to call and a 1-of-1 fails the threshold check in `setArbiter`.
    function getThreshold() external view returns (uint256);
}

/// @notice Hold types mirrored from ATS, so the pool can address holds without importing
///         the whole diamond interface.
interface IHoldTypes {
    struct HoldIdentifier {
        bytes32 partition;
        address tokenHolder;
        uint256 holdId;
    }

    struct Hold {
        uint256 amount;
        uint256 expirationTimestamp;
        address escrow;
        address to;
        bytes data;
    }

    /// @dev The envelope the holder signs. `deadline` and `nonce` are checked against ATS's
    ///      own nonce slot for that holder, so a signature is single-use.
    struct ProtectedHold {
        Hold hold;
        uint256 deadline;
        uint256 nonce;
    }
}

interface IAtsEsop {
    /// @dev Returns the hold's CURRENT amount — ATS scales it by the adjust-balance factor,
    ///      so this is the only trustworthy source after a stock split.
    function getHoldForByPartition(
        IHoldTypes.HoldIdentifier calldata holdIdentifier
    )
        external
        view
        returns (
            uint256 amount,
            uint256 expirationTimestamp,
            address escrow,
            address destination,
            bytes memory data,
            bytes memory operatorData,
            uint8 thirdPartyType
        );

    /// @dev Creates a hold on the holder's behalf, authorised by their EIP-712 signature.
    ///      Returns the new hold's id, which is what lets a caller place a hold and act on it
    ///      in one transaction. The CALLER needs the partition's participant role; the
    ///      signature only proves the holder consented.
    function protectedCreateHoldByPartition(
        bytes32 partition,
        address from,
        IHoldTypes.ProtectedHold calldata protectedHold,
        bytes calldata signature
    ) external returns (bool success, uint256 holdId);

    /**
     * @dev Only the escrow may execute a hold, and only to a KYC'd, allowlisted address. This
     *      is the liquidation path, and the compliance check still runs — which is why the
     *      lending pool has to be onboarded as a holder before it can seize anything.
     *      REVERTS once the hold has expired; past that, only the holder may reclaim.
     */
    function executeHoldByPartition(
        IHoldTypes.HoldIdentifier calldata holdIdentifier,
        address to,
        uint256 amount
    ) external returns (bool success, bytes32 partition);

    /**
     * @dev Returns held tokens to the holder. Unlike execute, this runs no compliance check —
     *      the tokens never left, so nothing is being transferred. Callable pre-expiry only,
     *      and only by the escrow; afterwards the holder reclaims directly on the token.
     */
    function releaseHoldByPartition(
        IHoldTypes.HoldIdentifier calldata holdIdentifier,
        uint256 amount
    ) external returns (bool success);

    /// @dev Caller must hold the tokens and ROLE_LOCKER. Moves `amount` from the caller to
    ///      `to` and locks it until `expirationTimestamp`.
    function transferAndLockByPartition(
        bytes32 partition,
        address to,
        uint256 amount,
        bytes calldata data,
        uint256 expirationTimestamp
    ) external returns (uint256 lockId);

    /// @dev Permissionless once the lock has expired — ANYONE may trigger a vest, which is
    ///      what makes automation optional rather than load-bearing. Reverts before expiry.
    function releaseByPartition(bytes32 partition, uint256 lockId, address tokenHolder) external returns (bool);

    /// @dev Skips the expiration check. Requires ROLE_LOCKER or ROLE_CONTROLLER. The clawback
    ///      path: unvested tranches must be unlocked before they can be moved back to the pool.
    function forceReleaseByPartition(bytes32 partition, uint256 lockId, address tokenHolder) external returns (bool);

    /// @dev Forced transfer. Requires ROLE_CONTROLLER and a controllable token. Used to move
    ///      forfeited options back into the pool without burning them.
    function controllerTransferByPartition(
        bytes32 partition,
        address from,
        address to,
        uint256 value,
        bytes calldata data,
        bytes calldata operatorData
    ) external returns (bytes32);

    /// @dev Burns from `tokenHolder`'s free balance. Requires ROLE_CONTROLLER and a controllable token.
    ///      Cannot reach locked or held tokens, so force-release must come first.
    function controllerRedeemByPartition(
        bytes32 partition,
        address tokenHolder,
        uint256 value,
        bytes calldata data,
        bytes calldata operatorData
    ) external;

    /// @dev Ordinary compliant transfer from the caller's own balance. Returns the partition
    ///      key rather than a success flag, and reverts on failure.
    function transferByPartition(
        bytes32 partition,
        BasicTransferInfo calldata transferInfo,
        bytes calldata data
    ) external returns (bytes32);

    /// @dev The lock's CURRENT amount, which ATS scales by the adjust-balance factor. After a
    ///      stock split this diverges from the amount recorded at grant time, so it is the
    ///      only trustworthy source when deciding how much to release or claw back.
    function getLockForByPartition(
        bytes32 partition,
        address tokenHolder,
        uint256 lockId
    ) external view returns (uint256 amount, uint256 expirationTimestamp);

    /// @dev The issuer's allowlist. False for anyone never onboarded, and for anyone suspended.
    function isInControlList(address account) external view returns (bool);

    /// @dev Total held in that partition, INCLUDING amounts locked or under a hold. It is not
    ///      the spendable figure; subtract `getLockedAmountForByPartition` for that.
    function balanceOfByPartition(bytes32 partition, address tokenHolder) external view returns (uint256);

    /// @dev Sum of every live lock in that partition — i.e. the unvested portion.
    function getLockedAmountForByPartition(bytes32 partition, address tokenHolder) external view returns (uint256);

    struct BasicTransferInfo {
        address to;
        uint256 value;
    }
}
