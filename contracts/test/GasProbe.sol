// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @notice Isolates the storage-pointer vs memory-copy question on ESOPVestingController's
 *         exact struct shapes, so the choice is settled by measurement rather than by a
 *         general rule of thumb. Test-only; never deployed.
 */
contract GasProbe {
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

    // Same layout as ESOPVestingController.Grant -- 4 slots:
    //   0: employee | 1: partition | 2: totalAmount+fundedAmount
    //   3: grantDate+terminatedAt+fundedTranches+status+leaver  (all packed together)
    struct Grant {
        address employee;
        bytes32 partition;
        uint128 totalAmount;
        uint128 fundedAmount;
        uint64 grantDate;
        uint64 terminatedAt;
        uint32 fundedTranches;
        GrantStatus status;
        LeaverType leaver;
    }

    // Same layout as ESOPVestingController.Tranche -- one packed slot (30 bytes).
    struct Tranche {
        uint128 amount;
        uint64 vestsAt;
        uint32 lockId;
        bool released;
        bool clawedBack;
    }

    mapping(uint256 => Grant) public grants;
    mapping(uint256 => Tranche[]) public tranches;

    uint256 public sink;

    /// @dev Every probe writes `sink`. Left at zero, the FIRST measured call would pay
    ///      ~20k for a zero-to-nonzero SSTORE and every later one ~2.9k, which swamps the
    ///      effect being measured. Warm it before comparing anything.
    function warm() external {
        sink = 1;
    }

    function seed(uint256 id, uint256 trancheCount) external {
        grants[id] = Grant({
            employee: address(0xBEEF),
            partition: bytes32(uint256(1)),
            totalAmount: 4800,
            fundedAmount: 4800,
            grantDate: uint64(block.timestamp),
            terminatedAt: 0,
            fundedTranches: uint32(trancheCount),
            status: GrantStatus.Active,
            leaver: LeaverType.None
        });
        for (uint256 i; i < trancheCount; ++i) {
            tranches[id].push(
                Tranche({
                    amount: 100,
                    vestsAt: uint64(block.timestamp + i * 30 days),
                    lockId: uint32(i + 1),
                    released: false,
                    clawedBack: false
                })
            );
        }
    }

    // ---- A. terminate(): write 3 fields that all live in the SAME packed slot ----

    function terminateViaStorage(uint256 id, uint64 at) external {
        Grant storage g = grants[id];
        g.status = GrantStatus.Terminated;
        g.terminatedAt = at;
        g.leaver = LeaverType.Bad;
    }

    function terminateViaMemory(uint256 id, uint64 at) external {
        Grant memory g = grants[id];
        g.status = GrantStatus.Terminated;
        g.terminatedAt = at;
        g.leaver = LeaverType.Bad;
        grants[id] = g;
    }

    // ---- B. read a couple of fields from a 4-slot struct ----

    function readViaStorage(uint256 id) external {
        Grant storage g = grants[id];
        sink = uint256(g.status) + uint256(g.terminatedAt);
    }

    function readViaMemory(uint256 id) external {
        Grant memory g = grants[id];
        sink = uint256(g.status) + uint256(g.terminatedAt);
    }

    // ---- C. the loop: read 5 fields of a packed Tranche, write 1 ----

    function loopViaStorage(uint256 id, uint32 maxCount) external {
        Grant storage g = grants[id];
        Tranche[] storage list = tranches[id];
        uint256 total;
        uint32 done;
        for (uint256 i; i < list.length && done < maxCount; ++i) {
            Tranche storage t = list[i];
            if (t.released || t.clawedBack || t.lockId == 0) continue;
            if (t.vestsAt > block.timestamp + 365 days) continue;
            t.released = true;
            total += t.amount + uint256(uint160(g.employee) & 1) + uint256(g.partition) % 2;
            unchecked {
                ++done;
            }
        }
        sink = total;
    }

    /// @dev Cache the invariants on the stack; read each packed Tranche slot once into
    ///      memory; keep the single mutation as a targeted storage write.
    function loopCached(uint256 id, uint32 maxCount) external {
        Grant storage g = grants[id];
        address employee = g.employee;
        bytes32 partition = g.partition;
        Tranche[] storage list = tranches[id];
        uint256 len = list.length;
        uint256 cutoff = block.timestamp + 365 days;

        uint256 total;
        uint32 done;
        for (uint256 i; i < len && done < maxCount; ++i) {
            Tranche memory t = list[i];
            if (t.released || t.clawedBack || t.lockId == 0) continue;
            if (t.vestsAt > cutoff) continue;
            list[i].released = true;
            total += t.amount + uint256(uint160(employee) & 1) + uint256(partition) % 2;
            unchecked {
                ++done;
            }
        }
        sink = total;
    }

    /// @dev The full memory-copy-and-write-back form, for completeness.
    function loopViaMemoryWriteback(uint256 id, uint32 maxCount) external {
        Grant memory g = grants[id];
        Tranche[] storage list = tranches[id];
        uint256 len = list.length;
        Tranche[] memory copy = new Tranche[](len);
        for (uint256 i; i < len; ++i) copy[i] = list[i];

        uint256 total;
        uint32 done;
        for (uint256 i; i < len && done < maxCount; ++i) {
            Tranche memory t = copy[i];
            if (t.released || t.clawedBack || t.lockId == 0) continue;
            if (t.vestsAt > block.timestamp + 365 days) continue;
            copy[i].released = true;
            total += t.amount + uint256(uint160(g.employee) & 1) + uint256(g.partition) % 2;
            unchecked {
                ++done;
            }
        }
        for (uint256 i; i < len; ++i) list[i] = copy[i];
        sink = total;
    }
}
