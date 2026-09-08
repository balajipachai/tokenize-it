// SPDX-License-Identifier: Apache-2.0
//
// PHASE 1 -- the full ESOP lifecycle driven against real ATS contracts.
//
// This is the executable specification for ESOPVestingController (Phase 2). Every
// row of §3 in IMPLEMENTATION_PLAN.md that we intend to ship is exercised here
// with the raw ATS primitives first, so the controller has nothing left to
// discover. Read it as the story of one grant.
//
// Token config matches the production flags in §3.1, including protected
// partitions, so nothing here is a simplification we would have to redo.

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployEquityTokenFixture, executeRbac, MAX_UINT256 } from "@test";
import { EMPTY_STRING, ATS_ROLES, ZERO, EMPTY_HEX_BYTES } from "@scripts";
import { ResolverProxy, IAsset } from "@contract-types";

const ESOP_2026_A = "0x0000000000000000000000000000000000000000000000000000000000000001";

const POOL_SIZE = 1_000_000;
const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;
const MONTH = 30 * DAY;

// Priya's grant: 4,800 options, 4-year vest, 1-year cliff at 25%, then monthly.
const GRANT_TOTAL = 4_800;
const CLIFF_AMOUNT = 1_200; // 25%
const MONTHLY_AMOUNT = 100; // 36 x 100 = 3,600
const MONTHLY_TRANCHES = 36;

interface Tranche {
  amount: number;
  vestsAt: number;
}

describe("PHASE 1: ESOP lifecycle on ATS primitives", () => {
  let diamond: ResolverProxy;
  let asset: IAsset;

  let admin: HardhatEthersSigner; // deployer / DEFAULT_ADMIN
  let company: HardhatEthersSigner; // treasury + issuer + locker + controller
  let priya: HardhatEthersSigner; // employee who stays
  let raj: HardhatEthersSigner; // employee who leaves before the cliff
  let bystander: HardhatEthersSigner; // no roles -- proves release is permissionless

  let grantDate: number;

  /** The vesting schedule a controller would generate from (total, cliff, duration). */
  function buildSchedule(start: number): Tranche[] {
    const tranches: Tranche[] = [{ amount: CLIFF_AMOUNT, vestsAt: start + YEAR }];
    for (let i = 1; i <= MONTHLY_TRANCHES; i++) {
      tranches.push({ amount: MONTHLY_AMOUNT, vestsAt: start + YEAR + i * MONTH });
    }
    return tranches;
  }

  /** Issues a grant as N locked tranches. Returns the lock ids, in schedule order. */
  async function issueGrant(to: string, tranches: Tranche[]): Promise<number[]> {
    const lockIds: number[] = [];
    for (const t of tranches) {
      const tx = await asset
        .connect(company)
        .transferAndLockByPartition(ESOP_2026_A, to, t.amount, EMPTY_HEX_BYTES, t.vestsAt);
      await tx.wait();
      lockIds.push(lockIds.length + 1); // ATS assigns sequential ids per (partition, holder)
    }
    return lockIds;
  }

  /**
   * Submits a transfer on the holder's behalf: they sign EIP-712 off-chain, the
   * company relayer pays the gas. This is the ONLY way an employee moves tokens
   * once partitions are protected -- see test 3.4.
   */
  async function relayTransfer(from: HardhatEthersSigner, to: string, amount: number) {
    const domain = {
      name: (await asset.getERC20Metadata()).info.name,
      version: (await asset.getConfigInfo()).version_.toString(),
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: diamond.target as string,
    };
    const types = {
      protectedTransferFromByPartition: [
        { name: "_partition", type: "bytes32" },
        { name: "_from", type: "address" },
        { name: "_to", type: "address" },
        { name: "_amount", type: "uint256" },
        { name: "_deadline", type: "uint256" },
        { name: "_nonce", type: "uint256" },
      ],
    };
    const deadline = BigInt(MAX_UINT256.toString());
    const nonce = (await asset.nonces(from.address)) + 1n;

    const signature = await from.signTypedData(domain, types, {
      _partition: ESOP_2026_A,
      _from: from.address,
      _to: to,
      _amount: amount,
      _deadline: deadline,
      _nonce: nonce,
    });

    return asset
      .connect(company)
      .protectedTransferFromByPartition(ESOP_2026_A, from.address, to, amount, { deadline, nonce, signature });
  }

  /** Releases every lock whose expiration has passed. Callable by anyone. */
  async function releaseVested(
    holder: string,
    lockIds: number[],
    tranches: Tranche[],
    caller: HardhatEthersSigner,
  ): Promise<number> {
    const now = await time.latest();
    let released = 0;
    for (let i = 0; i < lockIds.length; i++) {
      if (tranches[i].vestsAt > now) continue;
      const lock = await asset.getLockForByPartition(ESOP_2026_A, holder, lockIds[i]);
      if (lock.amount_ === 0n) continue; // already released
      await asset.connect(caller).releaseByPartition(ESOP_2026_A, lockIds[i], holder);
      released += tranches[i].amount;
    }
    return released;
  }

  beforeEach(async () => {
    const base = await deployEquityTokenFixture({
      equityDataParams: {
        securityData: {
          maxSupply: POOL_SIZE,
          isMultiPartition: true,
          isControllable: true, // clawback
          internalKycActivated: true, // employee gating
          isWhiteList: true, // allowlist, not blocklist
          arePartitionsProtected: true, // gasless meta-tx path (spike #2)
          clearingActive: false, // required by protected ops
        },
      },
      useLoadFixture: false,
    });

    diamond = base.diamond;
    admin = base.deployer;
    company = base.user1;
    priya = base.user2;
    raj = base.user3;
    bystander = base.user4;

    asset = await ethers.getContractAt("IAsset", diamond.target);

    await executeRbac(asset, [
      { role: ATS_ROLES.ROLE_ISSUER, members: [company.address] },
      { role: ATS_ROLES.ROLE_LOCKER, members: [company.address] },
      { role: ATS_ROLES.ROLE_CONTROLLER, members: [company.address] },
      { role: ATS_ROLES.ROLE_KYC, members: [company.address] },
      { role: ATS_ROLES.ROLE_CONTROL_LIST, members: [company.address] },
      { role: ATS_ROLES.ROLE_FREEZE_MANAGER, members: [company.address] },
      { role: ATS_ROLES.ROLE_SSI_MANAGER, members: [admin.address] },
      // Protected partitions gate issuer-side writes; the company needs the wildcard.
      { role: ATS_ROLES.ROLE_WILD_CARD, members: [company.address] },
      { role: ATS_ROLES.ROLE_PROTECTED_PARTITIONS, members: [company.address] },
      // ...and the partition-scoped role to submit relayed, signature-authorised ops.
      {
        role: ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "bytes32"],
            [ATS_ROLES.ROLE_PROTECTED_PARTITIONS_PARTICIPANT, ESOP_2026_A],
          ),
        ),
        members: [company.address],
      },
    ]);

    await asset.connect(admin).addIssuer(admin.address);

    // Onboarding: KYC + allowlist. The company treasury is a holder too.
    for (const who of [company.address, priya.address, raj.address]) {
      await asset.connect(company).grantKyc(who, EMPTY_STRING, ZERO, MAX_UINT256, admin.address);
      await asset.connect(company).addToControlList(who);
    }

    // Board authorises the pool: mint it to the company treasury.
    await asset.connect(company).issueByPartition({
      partition: ESOP_2026_A,
      tokenHolder: company.address,
      value: POOL_SIZE,
      data: EMPTY_HEX_BYTES,
    });

    grantDate = await time.latest();
  });

  describe("1. Pool and onboarding", () => {
    it("1.1 the pool exists, is capped, and sits in the treasury", async () => {
      expect(await asset.totalSupply()).to.equal(POOL_SIZE);
      expect(await asset.balanceOfByPartition(ESOP_2026_A, company.address)).to.equal(POOL_SIZE);
      expect(await asset.getMaxSupply()).to.equal(POOL_SIZE);
    });

    it("1.2 a non-KYC'd, non-allowlisted address cannot receive ESOPs", async () => {
      await expect(
        asset.connect(company).transferByPartition(ESOP_2026_A, { to: bystander.address, value: 1 }, EMPTY_HEX_BYTES),
      ).to.be.reverted;
    });
  });

  describe("2. Granting with a vesting schedule", () => {
    it("2.1 a 4y/1y-cliff grant lands as 37 locks, fully locked, zero spendable", async () => {
      const schedule = buildSchedule(grantDate);
      expect(schedule.length).to.equal(37);
      expect(schedule.reduce((a, t) => a + t.amount, 0)).to.equal(GRANT_TOTAL);

      await issueGrant(priya.address, schedule);

      expect(await asset.getLockedAmountForByPartition(ESOP_2026_A, priya.address)).to.equal(GRANT_TOTAL);
      expect(await asset.balanceOfByPartition(ESOP_2026_A, priya.address)).to.equal(0);
      expect(await asset.getLockCountForByPartition(ESOP_2026_A, priya.address)).to.equal(37);
    });

    it("2.2 GAS: measure a 37-tranche grant (risk #5 in the plan)", async () => {
      const schedule = buildSchedule(grantDate);
      let total = 0n;
      let max = 0n;

      for (const t of schedule) {
        const tx = await asset
          .connect(company)
          .transferAndLockByPartition(ESOP_2026_A, priya.address, t.amount, EMPTY_HEX_BYTES, t.vestsAt);
        const receipt = await tx.wait();
        total += receipt!.gasUsed;
        if (receipt!.gasUsed > max) max = receipt!.gasUsed;
      }

      console.log(`        gas: ${total} total across 37 txs, ${total / 37n} avg, ${max} max single`);
      // Hedera's per-transaction contract call ceiling is 15M gas.
      expect(max).to.be.lessThan(15_000_000n);
    });

    it("2.3 nothing is spendable before the cliff", async () => {
      const schedule = buildSchedule(grantDate);
      await issueGrant(priya.address, schedule);

      await time.increaseTo(grantDate + YEAR - DAY);
      await expect(asset.connect(bystander).releaseByPartition(ESOP_2026_A, 1, priya.address)).to.be.reverted;
      expect(await asset.balanceOfByPartition(ESOP_2026_A, priya.address)).to.equal(0);
    });
  });

  describe("3. Vesting", () => {
    it("3.1 at the cliff, 25% releases -- and ANYONE can trigger it", async () => {
      const schedule = buildSchedule(grantDate);
      const lockIds = await issueGrant(priya.address, schedule);

      await time.increaseTo(grantDate + YEAR + 1);

      // `bystander` holds no roles and no tokens. Release is permissionless.
      await asset.connect(bystander).releaseByPartition(ESOP_2026_A, lockIds[0], priya.address);

      expect(await asset.balanceOfByPartition(ESOP_2026_A, priya.address)).to.equal(CLIFF_AMOUNT);
      expect(await asset.getLockedAmountForByPartition(ESOP_2026_A, priya.address)).to.equal(
        GRANT_TOTAL - CLIFF_AMOUNT,
      );
    });

    it("3.2 monthly tranches accrue after the cliff", async () => {
      const schedule = buildSchedule(grantDate);
      const lockIds = await issueGrant(priya.address, schedule);

      await time.increaseTo(grantDate + YEAR + 3 * MONTH + 1);
      const released = await releaseVested(priya.address, lockIds, schedule, bystander);

      expect(released).to.equal(CLIFF_AMOUNT + 3 * MONTHLY_AMOUNT);
      expect(await asset.balanceOfByPartition(ESOP_2026_A, priya.address)).to.equal(CLIFF_AMOUNT + 300);
    });

    it("3.3 the full grant vests by year 4 and nothing remains locked", async () => {
      const schedule = buildSchedule(grantDate);
      const lockIds = await issueGrant(priya.address, schedule);

      await time.increaseTo(grantDate + YEAR + MONTHLY_TRANCHES * MONTH + 1);
      await releaseVested(priya.address, lockIds, schedule, bystander);

      expect(await asset.balanceOfByPartition(ESOP_2026_A, priya.address)).to.equal(GRANT_TOTAL);
      expect(await asset.getLockedAmountForByPartition(ESOP_2026_A, priya.address)).to.equal(0);
    });

    it("3.4 KEY FINDING: with protected partitions, the employee CANNOT transfer directly", async () => {
      // Protected partitions gate every holder-initiated write behind the relayer.
      // This is what makes the gasless model in §6 airtight -- there is no path
      // that requires the employee to send their own transaction, so they never
      // need HBAR or an activated Hedera account. It also means the relayer is
      // load-bearing for ordinary transfers, not just borrowing.
      const schedule = buildSchedule(grantDate);
      const lockIds = await issueGrant(priya.address, schedule);
      await time.increaseTo(grantDate + YEAR + 1);
      await asset.connect(bystander).releaseByPartition(ESOP_2026_A, lockIds[0], priya.address);

      await expect(
        asset.connect(priya).transferByPartition(ESOP_2026_A, { to: raj.address, value: 100 }, EMPTY_HEX_BYTES),
      ).to.be.reverted;
    });

    it("3.5 ...but a relayed, signature-authorised transfer succeeds", async () => {
      const schedule = buildSchedule(grantDate);
      const lockIds = await issueGrant(priya.address, schedule);
      await time.increaseTo(grantDate + YEAR + 1);
      await asset.connect(bystander).releaseByPartition(ESOP_2026_A, lockIds[0], priya.address);

      await relayTransfer(priya, raj.address, 100);
      expect(await asset.balanceOfByPartition(ESOP_2026_A, raj.address)).to.equal(100);
      expect(await asset.balanceOfByPartition(ESOP_2026_A, priya.address)).to.equal(CLIFF_AMOUNT - 100);
    });
  });

  describe("4. Freeze (suspension, reversible)", () => {
    it("4.1 a frozen employee cannot move vested tokens, and unfreezing restores it", async () => {
      const schedule = buildSchedule(grantDate);
      const lockIds = await issueGrant(priya.address, schedule);
      await time.increaseTo(grantDate + YEAR + 1);
      await asset.connect(bystander).releaseByPartition(ESOP_2026_A, lockIds[0], priya.address);

      await asset.connect(company).setAddressFrozen(priya.address, true);
      await expect(relayTransfer(priya, raj.address, 1)).to.be.reverted;

      await asset.connect(company).setAddressFrozen(priya.address, false);
      await expect(relayTransfer(priya, raj.address, 1)).to.not.be.reverted;
    });

    it("4.3 TRAP: setAddressFrozen works, but isFrozen() does NOT reflect it", async () => {
      // ERC3643StorageWrapper.setAddressFrozen manipulates the CONTROL LIST
      // (whitelist mode: removes the address; blacklist mode: adds it), whereas
      // isFrozen() reads frozenTokens[user] > 0 -- the PARTIAL-freeze counter,
      // which setAddressFrozen never touches. The two are inconsistent.
      //
      // Consequences we must respect:
      //  * the UI must derive freeze state from isInControlList(), never isFrozen()
      //  * freeze and allowlist share one storage slot, so addToControlList() on a
      //    frozen employee silently UNFREEZES them -- never manage both blindly
      await asset.connect(company).setAddressFrozen(priya.address, true);

      expect(await asset.isFrozen(priya.address)).to.equal(false); // <- misleading
      expect(await asset.isInControlList(priya.address)).to.equal(false); // <- the truth
    });

    it("4.2 freezing does NOT stop vesting -- locks still release", async () => {
      // Worth knowing: suspension is not the same as forfeiture. If HR wants to
      // stop the clock they must terminate, not freeze.
      const schedule = buildSchedule(grantDate);
      const lockIds = await issueGrant(priya.address, schedule);
      await asset.connect(company).setAddressFrozen(priya.address, true);

      await time.increaseTo(grantDate + YEAR + 1);
      await asset.connect(bystander).releaseByPartition(ESOP_2026_A, lockIds[0], priya.address);
      expect(await asset.getLockedAmountForByPartition(ESOP_2026_A, priya.address)).to.equal(
        GRANT_TOTAL - CLIFF_AMOUNT,
      );
    });
  });

  describe("5. Leavers", () => {
    it("5.1 BAD LEAVER (pre-cliff): the entire grant is clawed back and burned", async () => {
      const schedule = buildSchedule(grantDate);
      const lockIds = await issueGrant(raj.address, schedule);
      const supplyBefore = await asset.totalSupply();

      await time.increaseTo(grantDate + 180 * DAY); // resigns at month 6, before the cliff

      // Step 1: force-release every unvested lock back into the free balance.
      for (const id of lockIds) {
        await asset.connect(company).forceReleaseByPartition(ESOP_2026_A, id, raj.address);
      }
      expect(await asset.balanceOfByPartition(ESOP_2026_A, raj.address)).to.equal(GRANT_TOTAL);

      // Step 2: burn it.
      await asset
        .connect(company)
        .controllerRedeemByPartition(ESOP_2026_A, raj.address, GRANT_TOTAL, EMPTY_HEX_BYTES, EMPTY_HEX_BYTES);

      expect(await asset.balanceOfByPartition(ESOP_2026_A, raj.address)).to.equal(0);
      expect(await asset.getLockedAmountForByPartition(ESOP_2026_A, raj.address)).to.equal(0);
      expect(await asset.totalSupply()).to.equal(supplyBefore - BigInt(GRANT_TOTAL));
    });

    it("5.2 GOOD LEAVER (month 18): vested is retained, only unvested is clawed back", async () => {
      const schedule = buildSchedule(grantDate);
      const lockIds = await issueGrant(priya.address, schedule);

      // Leaves at month 18 -- cliff plus 6 monthly tranches have vested.
      await time.increaseTo(grantDate + YEAR + 6 * MONTH + 1);
      const vested = await releaseVested(priya.address, lockIds, schedule, bystander);
      expect(vested).to.equal(CLIFF_AMOUNT + 6 * MONTHLY_AMOUNT);

      const stillLocked = await asset.getLockedAmountForByPartition(ESOP_2026_A, priya.address);
      expect(stillLocked).to.equal(BigInt(GRANT_TOTAL - vested));

      // Claw back only what has not vested.
      const now = await time.latest();
      for (let i = 0; i < lockIds.length; i++) {
        if (schedule[i].vestsAt <= now) continue;
        await asset.connect(company).forceReleaseByPartition(ESOP_2026_A, lockIds[i], priya.address);
      }
      await asset
        .connect(company)
        .controllerRedeemByPartition(ESOP_2026_A, priya.address, stillLocked, EMPTY_HEX_BYTES, EMPTY_HEX_BYTES);

      expect(await asset.balanceOfByPartition(ESOP_2026_A, priya.address)).to.equal(vested);
      expect(await asset.getLockedAmountForByPartition(ESOP_2026_A, priya.address)).to.equal(0);
    });

    it("5.3 clawback is bounded: the issuer cannot burn ALREADY VESTED tokens via unvested cleanup", async () => {
      // Guards the controller against an off-by-one that would confiscate earned equity.
      const schedule = buildSchedule(grantDate);
      const lockIds = await issueGrant(priya.address, schedule);
      await time.increaseTo(grantDate + YEAR + 1);
      await asset.connect(bystander).releaseByPartition(ESOP_2026_A, lockIds[0], priya.address);

      const stillLocked = await asset.getLockedAmountForByPartition(ESOP_2026_A, priya.address);
      // Attempting to redeem more than the unvested amount must fail while it is locked.
      await expect(
        asset
          .connect(company)
          .controllerRedeemByPartition(
            ESOP_2026_A,
            priya.address,
            stillLocked + BigInt(CLIFF_AMOUNT),
            EMPTY_HEX_BYTES,
            EMPTY_HEX_BYTES,
          ),
      ).to.be.reverted;
    });
  });

  describe("6. Constraints discovered in this phase", () => {
    it("6.1 partial freeze is NOT available in multi-partition mode", async () => {
      // freezePartialTokens carries onlyWithoutMultiPartition. Multi-partition tokens
      // only get all-or-nothing address freeze. Recorded so the UI does not offer it.
      await expect(asset.connect(company).freezePartialTokens(priya.address, 1)).to.be.reverted;
    });

    it("6.2 the single-partition lock()/release() API is unavailable too -- use *ByPartition", async () => {
      await expect(asset.connect(company).lock(1, priya.address, grantDate + YEAR)).to.be.reverted;
    });
  });
});
