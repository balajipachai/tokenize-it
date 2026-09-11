// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @notice Measures whether `unchecked { ++i; }` still buys anything on solc 0.8.28.
 * @dev Test-only. The received wisdom that a manual unchecked increment saves gas dates from
 *      before 0.8.22, which made the compiler emit the unchecked form itself whenever it can
 *      prove the counter cannot overflow. This exists so the answer is measured here rather
 *      than assumed from a blog post.
 */
contract LoopProbe {
    uint256 public sink;

    function checkedLoop(uint256 n) external {
        uint256 acc = sink;
        for (uint256 i; i < n; ++i) {
            acc += i;
        }
        sink = acc;
    }

    function uncheckedLoop(uint256 n) external {
        uint256 acc = sink;
        for (uint256 i; i < n; ) {
            acc += i;
            unchecked {
                ++i;
            }
        }
        sink = acc;
    }
}

/**
 * @notice Measures the hand-rolled reentrancy guard this repo used to ship against OZ's.
 * @dev Test-only. Both are correct; the question is what the 0→1→0 pattern costs versus
 *      OZ's 1→2→1. The first writes a zero slot on every call (a cold-ish SSTORE) and then
 *      clears it for a refund that the 20%-of-transaction cap often swallows. The second
 *      warms the slot in its constructor and never returns it to zero, so it pays the
 *      much cheaper non-zero-to-non-zero write twice.
 */
contract HandRolledGuardProbe {
    uint256 public sink;
    uint256 private _entered;

    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    function work() external nonReentrant {
        sink += 1;
    }
}

/// @dev The same body behind OZ's guard, so the delta is the guard and nothing else.
contract OzGuardProbe is ReentrancyGuard {
    uint256 public sink;

    function work() external nonReentrant {
        sink += 1;
    }
}
