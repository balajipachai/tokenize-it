// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice The slice of ERC-20 the lending pool needs.
interface IERC20Minimal {
    /// @notice Token held by `account`, in the token's own decimals.
    function balanceOf(address account) external view returns (uint256);

    /// @dev Return value is CHECKED at every call site. Plenty of real tokens return false
    ///      instead of reverting, and ignoring it would book a failed payout as a success.
    function transfer(address to, uint256 amount) external returns (bool);

    /// @dev Also checked. Requires the caller to have been approved for `amount` first.
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /// @dev Declared but not relied upon — the pool takes the stablecoin's decimals as a
    ///      constructor argument instead, because this is an optional part of ERC-20 and
    ///      some tokens simply do not implement it.
    function decimals() external view returns (uint8);
}
