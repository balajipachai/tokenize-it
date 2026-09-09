// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice Minimal stand-in for a Safe: only the threshold check matters to the controller.
///         Test-only; never deployed.
contract MockMultisig {
    uint256 private _threshold;
    address public immutable executor;

    constructor(uint256 threshold_, address executor_) {
        _threshold = threshold_;
        executor = executor_;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    /// @dev Lets a test drive a call as though the multisig had reached its threshold.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == executor, "not executor");
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "call failed");
        return ret;
    }
}
