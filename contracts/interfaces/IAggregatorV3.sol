// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @notice Chainlink's price-feed interface.
 * @dev Declared locally so our own NAV oracle can implement the same shape. That is the
 *      point: a private company has no public price, but a listed one does, and speaking
 *      Chainlink's language means swapping our oracle for a real feed is a setter call
 *      rather than a rewrite.
 */
interface IAggregatorV3 {
    /// @dev Decimal places of `answer`. Chainlink USD feeds use 8; never assume 18.
    function decimals() external view returns (uint8);

    /// @notice Human-readable pair name, e.g. "USDC / USD".
    function description() external view returns (string memory);

    /**
     * @notice The most recent answer and when it was written.
     * @dev Consumers must treat `updatedAt` as load-bearing and refuse an answer older than
     *      their own bound — a feed that has stopped updating keeps returning its last price
     *      quite happily. `ESOPLendingPool` carries a separate bound per feed for this.
     */
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
