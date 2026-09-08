// SPDX-License-Identifier: Apache-2.0
//
// PHASE 2 -- ESOPVestingController.
//
// esopLifecycle.test.ts proved the raw ATS primitives behave. This suite proves
// the controller composes them correctly, and focuses hardest on the leaver
// matrix, because a clawback bug confiscates equity somebody actually earned.

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployEquityTokenFixture, executeRbac, MAX_UINT256 } from "@test";
import { EMPTY_STRING, ATS_ROLES, ZERO, EMPTY_HEX_BYTES } from "@scripts";
import { IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const POOL_SIZE = 1_000_000;
const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;
const MONTH = 30 * DAY;

const CLIFF = 1_200;
const MONTHLY = 100;
const MONTHLY_COUNT = 36;
const GRANT_TOTAL = CLIFF + MONTHLY * MONTHLY_COUNT; // 4,800

enum GrantStatus {
  None,
  Funding,
  Active,
  Terminated,
}
enum LeaverType {
  None,
  Good,
  Bad,
}

describe("PHASE 2: ESOPVestingController", () => {
  let asset: IAsset;
  let controller: any;
  let controllerAddress: string;

  let admin: HardhatEthersSigner;
  let hr: HardhatEthersSigner;
  let priya: HardhatEthersSigner;
  let raj: HardhatEthersSigner;
  let bystander: HardhatEthersSigner;

  let start: number;

  function schedule(from: number): { amounts: number[]; dates: number[] } {
    const amounts = [CLIFF];
    const dates = [from + YEAR];
    for (let i = 1; i <= MONTHLY_COUNT; i++) {
      amounts.push(MONTHLY);
      dates.push(from + YEAR + i * MONTH);
    }
    return { amounts, dates };
  }

  /** Funds every tranche, in batches, the way an issuer console would. */
  async function fundAll(grantId: number, batch = 20) {
    for (;;) {
      await controller.connect(hr).fundTranches(grantId, batch);
      const g = await controller.getGrant(grantId);
      if (Number(g.status) === GrantStatus.Active) return;
    }
  }

  async function newGrant(employee: string, from?: number): Promise<number> {
    const s = schedule(from ?? (await time.latest()));
    const id = Number(await controller.nextGrantId());
    await controller.connect(hr).createGrant(employee, PARTITION, s.amounts, s.dates);
    return id;
  }

  beforeEach(async () => {
    const base = await deployEquityTokenFixture({
      equityDataParams: {
        securityData: {
          maxSupply: POOL_SIZE,
          isMultiPartition: true,
          isControllable: true,
          internalKycActivated: true,
          isWhiteList: true,
          arePartitionsProtected: true,
          clearingActive: false,
        },
      },
    });

    admin = base.deployer;
    hr = base.user1;
    priya = base.user2;
    raj = base.user3;
    bystander = base.user4;

    asset = await ethers.getContractAt("IAsset", base.diamond.target);

    const Factory = await ethers.getContractFactory("ESOPVestingController");
    controller = await Factory.deploy(base.diamond.target, hr.address);
    await controller.waitForDeployment();
    controllerAddress = await controller.getAddress();

    await executeRbac(asset, [
      { role: ATS_ROLES.ROLE_ISSUER, members: [admin.address] },
      { role: ATS_ROLES.ROLE_KYC, members: [admin.address] },
      { role: ATS_ROLES.ROLE_CONTROL_LIST, members: [admin.address] },
      { role: ATS_ROLES.ROLE_SSI_MANAGER, members: [admin.address] },
      // The controller holds the pool and drives locks, clawback and protected ops.
      { role: ATS_ROLES.ROLE_LOCKER, members: [controllerAddress] },
      { role: ATS_ROLES.ROLE_CONTROLLER, members: [controllerAddress] },
      { role: ATS_ROLES.ROLE_WILD_CARD, members: [controllerAddress] },
    ]);

    await asset.connect(admin).addIssuer(admin.address);
    for (const who of [admin.address, controllerAddress, priya.address, raj.address]) {
      await asset.connect(admin).grantKyc(who, EMPTY_STRING, ZERO, MAX_UINT256, admin.address);
      await asset.connect(admin).addToControlList(who);
    }

    // Board authorises the pool and hands it to the controller.
    await asset.connect(admin).issueByPartition({
      partition: PARTITION,
      tokenHolder: controllerAddress,
      value: POOL_SIZE,
      data: EMPTY_HEX_BYTES,
    });

    start = await time.latest();
  });

  describe("1. Creating grants", () => {
    it("1.1 records the schedule without locking anything", async () => {
      const id = await newGrant(priya.address);
      const g = await controller.getGrant(id);

      expect(g.employee).to.equal(priya.address);
      expect(g.totalAmount).to.equal(GRANT_TOTAL);
      expect(g.fundedAmount).to.equal(0);
      expect(Number(g.status)).to.equal(GrantStatus.Funding);
      expect((await controller.getTranches(id)).length).to.equal(37);
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(0);
    });

    it("1.2 rejects malformed schedules", async () => {
      const s = schedule(start);
      await expect(
        controller.connect(hr).createGrant(priya.address, PARTITION, s.amounts, s.dates.slice(1)),
      ).to.be.revertedWithCustomError(controller, "ScheduleLengthMismatch");

      await expect(
        controller.connect(hr).createGrant(priya.address, PARTITION, [], []),
      ).to.be.revertedWithCustomError(controller, "EmptySchedule");

      await expect(
        controller.connect(hr).createGrant(priya.address, PARTITION, [100, 100], [start + YEAR, start + YEAR]),
      ).to.be.revertedWithCustomError(controller, "TrancheDatesNotIncreasing");

      await expect(
        controller.connect(hr).createGrant(priya.address, PARTITION, [100], [start - 1]),
      ).to.be.revertedWithCustomError(controller, "VestDateInPast");

      await expect(
        controller.connect(hr).createGrant(priya.address, PARTITION, [0], [start + YEAR]),
      ).to.be.revertedWithCustomError(controller, "ZeroAmount");
    });

    it("1.3 only a grant admin may create grants", async () => {
      const s = schedule(start);
      await expect(controller.connect(priya).createGrant(priya.address, PARTITION, s.amounts, s.dates)).to.be.reverted;
    });
  });

  describe("2. Funding in batches", () => {
    it("2.1 funds across several calls and activates only when complete", async () => {
      const id = await newGrant(priya.address);

      await controller.connect(hr).fundTranches(id, 20);
      let g = await controller.getGrant(id);
      expect(g.fundedTranches).to.equal(20);
      expect(Number(g.status)).to.equal(GrantStatus.Funding);

      await controller.connect(hr).fundTranches(id, 20);
      g = await controller.getGrant(id);
      expect(g.fundedTranches).to.equal(37);
      expect(g.fundedAmount).to.equal(GRANT_TOTAL);
      expect(Number(g.status)).to.equal(GrantStatus.Active);

      expect(await asset.getLockedAmountForByPartition(PARTITION, priya.address)).to.equal(GRANT_TOTAL);
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(0);
    });

    it("2.2 GAS: each funding batch must stay under Hedera's 15M ceiling", async () => {
      const id = await newGrant(priya.address);
      let worst = 0n;
      for (;;) {
        const rc = await (await controller.connect(hr).fundTranches(id, 20)).wait();
        if (rc.gasUsed > worst) worst = rc.gasUsed;
        if (Number((await controller.getGrant(id)).status) === GrantStatus.Active) break;
      }
      console.log(`        worst funding batch (20 tranches): ${worst} gas`);
      expect(worst).to.be.lessThan(15_000_000n);
    });

    it("2.3 funding a completed grant reverts", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);
      await expect(controller.connect(hr).fundTranches(id, 5)).to.be.revertedWithCustomError(
        controller,
        "GrantNotFunding",
      );
    });
  });

  describe("3. Vesting", () => {
    it("3.1 nothing releases before the cliff", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);
      await time.increaseTo(start + YEAR - DAY);

      await controller.connect(bystander).releaseVested(id, 50);
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(0);
      expect(await controller.vestedAmount(id)).to.equal(0);
    });

    it("3.2 at the cliff, 25% releases -- and ANYONE can trigger it", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);
      await time.increaseTo(start + YEAR + 1);

      await controller.connect(bystander).releaseVested(id, 50);

      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(CLIFF);
      expect(await controller.vestedAmount(id)).to.equal(CLIFF);
      expect(await controller.unvestedAmount(id)).to.equal(GRANT_TOTAL - CLIFF);
    });

    it("3.3 monthly tranches accrue, and releaseVested is idempotent", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);
      await time.increaseTo(start + YEAR + 3 * MONTH + 1);

      await controller.connect(bystander).releaseVested(id, 50);
      const expected = CLIFF + 3 * MONTHLY;
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(expected);

      // Calling again must be a no-op, not a double-release or a revert.
      await controller.connect(bystander).releaseVested(id, 50);
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(expected);
    });

    it("3.4 maxCount bounds the work per call", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);
      await time.increaseTo(start + YEAR + 5 * MONTH + 1);

      await controller.connect(bystander).releaseVested(id, 2);
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(CLIFF + MONTHLY);
      expect(await controller.pendingTranches(id)).to.equal(4);

      await controller.connect(bystander).releaseVested(id, 50);
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(CLIFF + 5 * MONTHLY);
      expect(await controller.pendingTranches(id)).to.equal(0);
    });

    it("3.5 tolerates a lock released directly on the token", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);
      await time.increaseTo(start + YEAR + 1);

      // Bypass the controller entirely -- vesting is permissionless on the token.
      const tranches = await controller.getTranches(id);
      await asset.connect(bystander).releaseByPartition(PARTITION, tranches[0].lockId, priya.address);

      await expect(controller.connect(bystander).releaseVested(id, 50)).to.not.be.reverted;
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(CLIFF);
    });

    it("3.6 the whole grant vests by year four", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);
      await time.increaseTo(start + YEAR + MONTHLY_COUNT * MONTH + 1);

      await controller.connect(bystander).releaseVested(id, 50);
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(GRANT_TOTAL);
      expect(await asset.getLockedAmountForByPartition(PARTITION, priya.address)).to.equal(0);
      expect(await controller.unvestedAmount(id)).to.equal(0);
      expect(await controller.nextVestAt(id)).to.equal(0);
    });
  });

  describe("4. Leavers", () => {
    it("4.1 BAD LEAVER pre-cliff: nothing vested, everything burned", async () => {
      const id = await newGrant(raj.address);
      await fundAll(id);
      const supplyBefore = await asset.totalSupply();

      await time.increaseTo(start + 180 * DAY);
      await controller.connect(hr).terminate(id, LeaverType.Bad, await time.latest());

      let burned = 0n;
      for (;;) {
        const rc = await (await controller.connect(hr).clawback(id, 20)).wait();
        const ev = rc.logs.map((l: any) => controller.interface.parseLog(l)).find((e: any) => e?.name === "ClawedBack");
        if (!ev) break;
        burned += ev.args.amount;
      }

      expect(burned).to.equal(GRANT_TOTAL);
      expect(await asset.balanceOfByPartition(PARTITION, raj.address)).to.equal(0);
      expect(await asset.getLockedAmountForByPartition(PARTITION, raj.address)).to.equal(0);
      expect(await asset.totalSupply()).to.equal(supplyBefore - BigInt(GRANT_TOTAL));
    });

    it("4.2 GOOD LEAVER at month 18: vested retained, unvested burned", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);

      await time.increaseTo(start + YEAR + 6 * MONTH + 1);
      await controller.connect(bystander).releaseVested(id, 50);
      const vested = CLIFF + 6 * MONTHLY;
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(vested);

      await controller.connect(hr).terminate(id, LeaverType.Good, await time.latest());
      for (;;) {
        await controller.connect(hr).clawback(id, 20);
        if ((await controller.unvestedAmount(id)) === 0n) break;
      }

      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(vested);
      expect(await asset.getLockedAmountForByPartition(PARTITION, priya.address)).to.equal(0);
    });

    it("4.3 THE CRITICAL ONE: vesting stops at the leaving date", async () => {
      // Without a frozen cutoff, a terminated employee would keep vesting while
      // HR worked through the clawback, and releaseVested is permissionless.
      const id = await newGrant(priya.address);
      await fundAll(id);

      await time.increaseTo(start + YEAR + 1); // only the cliff has vested
      await controller.connect(hr).terminate(id, LeaverType.Good, await time.latest());

      // Two more years pass before anyone finishes the paperwork.
      await time.increaseTo(start + 3 * YEAR);
      await controller.connect(bystander).releaseVested(id, 50);

      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(CLIFF);
      expect(await controller.vestedAmount(id)).to.equal(CLIFF);
    });

    it("4.4 back-dating to the real last working day forfeits more", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);

      await time.increaseTo(start + YEAR + 3 * MONTH + 1);
      // Resignation was actually effective one day before the cliff.
      await controller.connect(hr).terminate(id, LeaverType.Bad, start + YEAR - DAY);

      await controller.connect(bystander).releaseVested(id, 50);
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(0);
      expect(await controller.vestedAmount(id)).to.equal(0);
    });

    it("4.5 already-released tranches are never clawed back", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);
      await time.increaseTo(start + YEAR + 1);
      await controller.connect(bystander).releaseVested(id, 50);

      await controller.connect(hr).terminate(id, LeaverType.Bad, await time.latest());
      for (;;) {
        await controller.connect(hr).clawback(id, 20);
        if ((await controller.unvestedAmount(id)) === 0n) break;
      }

      // Even a bad leaver keeps what already vested -- forfeiture is not confiscation.
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(CLIFF);
    });

    it("4.6 termination cannot be forward-dated or pre-dated to before the grant", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);
      const now = await time.latest();

      await expect(
        controller.connect(hr).terminate(id, LeaverType.Bad, now + YEAR),
      ).to.be.revertedWithCustomError(controller, "EffectiveDateInFuture");

      await expect(
        controller.connect(hr).terminate(id, LeaverType.Bad, start - DAY),
      ).to.be.revertedWithCustomError(controller, "EffectiveDateBeforeGrant");
    });

    it("4.7 clawback requires termination, and only a grant admin may do either", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);

      await expect(controller.connect(hr).clawback(id, 5)).to.be.revertedWithCustomError(
        controller,
        "GrantNotTerminated",
      );
      await expect(controller.connect(priya).terminate(id, LeaverType.Bad, await time.latest())).to.be.reverted;
    });

    it("4.8 terminating twice reverts", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);
      await controller.connect(hr).terminate(id, LeaverType.Good, await time.latest());
      await expect(
        controller.connect(hr).terminate(id, LeaverType.Good, await time.latest()),
      ).to.be.revertedWithCustomError(controller, "GrantAlreadyTerminated");
    });

    it("4.9 clawback is idempotent once everything is burned", async () => {
      const id = await newGrant(raj.address);
      await fundAll(id);
      await controller.connect(hr).terminate(id, LeaverType.Bad, await time.latest());
      for (;;) {
        await controller.connect(hr).clawback(id, 20);
        if ((await controller.unvestedAmount(id)) === 0n) break;
      }
      await expect(controller.connect(hr).clawback(id, 20)).to.not.be.reverted;
      expect(await asset.balanceOfByPartition(PARTITION, raj.address)).to.equal(0);
    });
  });

  describe("5. Multiple grants and bookkeeping", () => {
    it("5.1 one employee can hold several independent grants", async () => {
      const first = await newGrant(priya.address);
      await fundAll(first);
      const second = await newGrant(priya.address);
      await fundAll(second);

      expect((await controller.grantsOf(priya.address)).map(Number)).to.deep.equal([first, second]);
      expect(await asset.getLockedAmountForByPartition(PARTITION, priya.address)).to.equal(GRANT_TOTAL * 2);

      await time.increaseTo(start + YEAR + 1);
      await controller.connect(bystander).releaseVested(first, 50);
      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(CLIFF);

      // Terminating one grant must not touch the other.
      await controller.connect(hr).terminate(first, LeaverType.Bad, await time.latest());
      expect(Number((await controller.getGrant(second)).status)).to.equal(GrantStatus.Active);
    });

    it("5.2 nextVestAt reports the upcoming cliff, then the next month", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);
      expect(await controller.nextVestAt(id)).to.equal(start + YEAR);

      await time.increaseTo(start + YEAR + 1);
      expect(await controller.nextVestAt(id)).to.equal(start + YEAR + MONTH);
    });

    it("5.3 unallocated pool tokens can be returned to the treasury", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);

      const left = await asset.balanceOfByPartition(PARTITION, controllerAddress);
      expect(left).to.equal(BigInt(POOL_SIZE - GRANT_TOTAL));

      await controller.connect(hr).returnToTreasury(PARTITION, admin.address, left);
      expect(await asset.balanceOfByPartition(PARTITION, controllerAddress)).to.equal(0);
      expect(await asset.balanceOfByPartition(PARTITION, admin.address)).to.equal(left);
    });

    it("5.4 unknown grants revert rather than silently doing nothing", async () => {
      await expect(controller.releaseVested(999, 5)).to.be.revertedWithCustomError(controller, "UnknownGrant");
    });
  });

  describe("6. Security review findings (solidity-dev skill pass)", () => {
    it("6.1 admin handover is two-step -- a typo'd address cannot strand the role", async () => {
      // This address can burn employee equity via clawback, so a one-step transfer to an
      // unreachable address would be unrecoverable.
      await controller.connect(hr).transferAdmin(bystander.address);
      expect(await controller.admin()).to.equal(hr.address); // unchanged until accepted
      expect(await controller.pendingAdmin()).to.equal(bystander.address);

      await expect(controller.connect(priya).acceptAdmin()).to.be.revertedWithCustomError(
        controller,
        "NotPendingAdmin",
      );

      await controller.connect(bystander).acceptAdmin();
      expect(await controller.admin()).to.equal(bystander.address);
      expect(await controller.pendingAdmin()).to.equal(ethers.ZeroAddress);
    });

    it("6.2 the grant-admin role is revocable, so a bad decider can be removed", async () => {
      await controller.connect(hr).setGrantAdmin(priya.address, true);
      await expect(newGrant(priya.address)).to.not.be.reverted;

      await controller.connect(hr).setGrantAdmin(priya.address, false);
      const s = schedule(await time.latest());
      await expect(
        controller.connect(priya).createGrant(priya.address, PARTITION, s.amounts, s.dates),
      ).to.be.revertedWithCustomError(controller, "NotGrantAdmin");
    });

    it("6.3 every termination is permanently attributed to the deciding address", async () => {
      // Employment ends off-chain, so the verdict is a parameter. The mitigation is
      // attribution, not cryptography.
      const id = await newGrant(priya.address);
      await fundAll(id);
      const at = await time.latest();

      await expect(controller.connect(hr).terminate(id, LeaverType.Bad, at))
        .to.emit(controller, "GrantTerminated")
        .withArgs(id, LeaverType.Bad, at, hr.address);
    });

    it("6.4 clawback burns the SPLIT-ADJUSTED amount, not the amount recorded at grant time", async () => {
      // ATS scales locks by the adjust-balance factor. Burning the stale, smaller number
      // would leave a bad leaver holding unvested equity they had already forfeited.
      const id = await newGrant(raj.address);
      await fundAll(id);

      await executeRbac(asset, [{ role: ATS_ROLES.ROLE_ADJUSTMENT_BALANCE, members: [admin.address] }]);
      await asset.connect(admin).adjustBalances(2, 0); // 2-for-1 split

      const lockedAfterSplit = await asset.getLockedAmountForByPartition(PARTITION, raj.address);
      expect(lockedAfterSplit).to.equal(BigInt(GRANT_TOTAL) * 2n);

      await controller.connect(hr).terminate(id, LeaverType.Bad, await time.latest());
      for (let i = 0; i < 5; i++) await controller.connect(hr).clawback(id, 20);

      // The whole split-adjusted grant is gone -- not just the pre-split nominal amount.
      expect(await asset.balanceOfByPartition(PARTITION, raj.address)).to.equal(0);
      expect(await asset.getLockedAmountForByPartition(PARTITION, raj.address)).to.equal(0);
    });

    it("6.5 releaseVested reports the split-adjusted amount too", async () => {
      const id = await newGrant(priya.address);
      await fundAll(id);

      await executeRbac(asset, [{ role: ATS_ROLES.ROLE_ADJUSTMENT_BALANCE, members: [admin.address] }]);
      await asset.connect(admin).adjustBalances(2, 0);

      await time.increaseTo(start + YEAR + 1);
      await controller.connect(bystander).releaseVested(id, 50);

      expect(await asset.balanceOfByPartition(PARTITION, priya.address)).to.equal(CLIFF * 2);
    });
  });
});
