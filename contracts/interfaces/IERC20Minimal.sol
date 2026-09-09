// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice The slice of ERC-20 the lending pool needs.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function decimals() external view returns (uint8);
}
