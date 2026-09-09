// SPDX-License-Identifier: Apache-2.0
//
// PHASE 4 -- borrowing against vested ESOPs.
//
// The mechanic under test is that collateral never leaves the borrower's wallet: it is an
// ERC-1400 hold, not a transfer. Spike #1 established the rules this suite leans on --
// pledging and repaying need no privileges, but liquidation is a real transfer and needs
// the pool KYC'd and allowlisted.

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployEquityTokenFixture, executeRbac, MAX_UINT256 } from "@test";
import { EMPTY_STRING, ATS_ROLES, ZERO, EMPTY_HEX_BYTES } from "@scripts";
import { IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const DAY = 24 * 60 * 60;

const VESTED = 10_000; // ESOP shares the borrower holds free and clear
const NAV_8DP = 2_00000000n; // $2.00 per share
const PEG_8DP = 1_00000000n; // $1.00
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

describe("PHASE 4: ESOPLendingPool", () => {
  let asset: IAsset;
  let pool: any;
  let nav: any;
  let peg: any;
  let usdc: any;
  let poolAddress: string;

  let admin: HardhatEthersSigner;
  let borrower: HardhatEthersSigner;
  let lp: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;

  /** Places a hold naming the pool as escrow and destination, the way the portal relays it. */
  async function pledge(amount: number, expiresIn = 90 * DAY): Promise<number> {
    const expiry = (await time.latest()) + expiresIn;
    await asset.connect(borrower).createHoldByPartition(PARTITION, {
      amount,
      expirationTimestamp: expiry,
      escrow: poolAddress,
      to: poolAddress,
      data: EMPTY_HEX_BYTES,
    });
    return Number(await asset.getHoldCountForByPartition(PARTITION, borrower.address));
  }

  beforeEach(async () => {
    const base = await deployEquityTokenFixture({
      equityDataParams: {
        securityData: {
          maxSupply: 1_000_000,
          isMultiPartition: true,
          isControllable: true,
          internalKycActivated: true,
          isWhiteList: true,
          // Left unprotected here so the borrower can place their own hold directly.
          // Production runs protected and relays it; spike #2 proved that path works, and
          // it is orthogonal to everything this suite is about.
          arePartitionsProtected: false,
          clearingActive: false,
        },
      },
    });
    admin = base.deployer;
    borrower = base.user1;
    lp = base.user2;
    keeper = base.user3;

    asset = await ethers.getContractAt("IAsset", base.diamond.target);

    const USDCFactory = await ethers.getContractFactory("MockUSDC");
    usdc = await USDCFactory.deploy();
    await usdc.waitForDeployment();

    const NavFactory = await ethers.getContractFactory("EsopNavOracle");
    nav = await NavFactory.deploy("ESOP / USD", admin.address, 5_000); // 50% max move
    await nav.waitForDeployment();
    await nav.publish(NAV_8DP, "409A 2026-01");

    const PegFactory = await ethers.getContractFactory("EsopNavOracle");
    peg = await PegFactory.deploy("USDC / USD", admin.address, 0);
    await peg.waitForDeployment();
    await peg.publish(PEG_8DP, "chainlink stand-in");

    const PoolFactory = await ethers.getContractFactory("ESOPLendingPool");
    pool = await PoolFactory.deploy(base.diamond.target, await usdc.getAddress(), 6, admin.address);
    await pool.waitForDeployment();
    poolAddress = await pool.getAddress();
    await pool.setFeeds(await nav.getAddress(), await peg.getAddress(), 400 * DAY, 2 * DAY);

    await executeRbac(asset, [
      { role: ATS_ROLES.ROLE_ISSUER, members: [admin.address] },
      { role: ATS_ROLES.ROLE_KYC, members: [admin.address] },
      { role: ATS_ROLES.ROLE_CONTROL_LIST, members: [admin.address] },
      { role: ATS_ROLES.ROLE_SSI_MANAGER, members: [admin.address] },
    ]);
    await asset.connect(admin).addIssuer(admin.address);

    // The pool is onboarded as a holder because liquidation transfers shares to it, and a
    // transfer to a non-KYC'd address reverts (spike #1).
    for (const who of [admin.address, borrower.address, poolAddress]) {
      await asset.connect(admin).grantKyc(who, EMPTY_STRING, ZERO, MAX_UINT256, admin.address);
      await asset.connect(admin).addToControlList(who);
    }

    await asset.connect(admin).issueByPartition({
      partition: PARTITION,
      tokenHolder: borrower.address,
      value: VESTED,
      data: EMPTY_HEX_BYTES,
    });

    await usdc.mint(lp.address, USDC(100_000));
    await usdc.connect(lp).approve(poolAddress, MAX_UINT256.toString());
    await pool.connect(lp).addLiquidity(USDC(100_000));
  });

  describe("1. Valuation", () => {
    it("1.1 prices collateral from both feeds, in stablecoin decimals", async () => {
      // 10,000 shares at $2.00, USDC at $1.00 -> $20,000 -> 20,000e6
      expect(await pool.collateralValue(VESTED)).to.equal(USDC(20_000));
    });

    it("1.2 a depegged stablecoin stops new borrowing rather than mispricing it", async () => {
      await peg.publish(90_000000n, "depeg"); // $0.90
      await expect(pool.collateralValue(VESTED)).to.be.revertedWithCustomError(pool, "StablecoinDepegged");
    });

    it("1.3 a stale feed is refused", async () => {
      await pool.setFeeds(await nav.getAddress(), await peg.getAddress(), 1, 2 * DAY);
      await time.increase(60);
      await expect(pool.collateralValue(VESTED)).to.be.revertedWithCustomError(pool, "StalePrice");
    });

    it("1.4 the NAV oracle refuses an implausible jump", async () => {
      // 50% cap: $2.00 -> $4.00 is a 100% move.
      await expect(nav.publish(4_00000000n, "typo")).to.be.revertedWithCustomError(nav, "DeviationTooLarge");
      await expect(nav.publish(2_50000000n, "round B")).to.not.be.reverted;
    });

    it("1.5 only a valuation agent can publish, and every price is attributed", async () => {
      await expect(nav.connect(borrower).publish(2_10000000n, "self-serve")).to.be.revertedWithCustomError(
        nav,
        "NotValuationAgent",
      );
      const round = await nav.latestRound();
      const [by, basis] = await nav.roundProvenance(round);
      expect(by).to.equal(admin.address);
      expect(basis).to.equal("409A 2026-01");
    });
  });

  describe("2. Borrowing", () => {
    it("2.1 borrows against a hold, and the shares never leave the wallet", async () => {
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));

      expect(await usdc.balanceOf(borrower.address)).to.equal(USDC(5_000));
      // The whole point: still the borrower's, just held.
      expect(await asset.getHeldAmountForByPartition(PARTITION, borrower.address)).to.equal(VESTED);
      expect(await asset.balanceOfByPartition(PARTITION, poolAddress)).to.equal(0);
    });

    it("2.2 refuses to lend above the maximum LTV", async () => {
      const holdId = await pledge(VESTED);
      // $20,000 collateral at 25% -> $5,000 ceiling
      await expect(
        pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_001)),
      ).to.be.revertedWithCustomError(pool, "ExceedsMaxLtv");
    });

    it("2.3 refuses a hold that names anyone else as escrow", async () => {
      const expiry = (await time.latest()) + 90 * DAY;
      await asset.connect(borrower).createHoldByPartition(PARTITION, {
        amount: VESTED,
        expirationTimestamp: expiry,
        escrow: keeper.address,
        to: keeper.address,
        data: EMPTY_HEX_BYTES,
      });
      const holdId = Number(await asset.getHoldCountForByPartition(PARTITION, borrower.address));
      await expect(pool.connect(borrower).borrow(PARTITION, holdId, USDC(100))).to.be.revertedWithCustomError(
        pool,
        "PoolNotEscrow",
      );
    });

    it("2.4 THE SPIKE #1 LESSON: a never-expiring hold cannot even be created", async () => {
      // Spike #1 found that held tokens are immune to the issuer's clawback, so a hold with
      // no expiry would be a permanent escape hatch. Good news: ATS refuses to create one at
      // all, so the risk is closed a layer below us. The pool keeps its own HoldNeverExpires
      // guard as belt-and-braces, since this is a property of ATS today rather than a
      // guarantee it owes us.
      await expect(
        asset.connect(borrower).createHoldByPartition(PARTITION, {
          amount: VESTED,
          expirationTimestamp: 0,
          escrow: poolAddress,
          to: poolAddress,
          data: EMPTY_HEX_BYTES,
        }),
      ).to.be.revertedWithCustomError(asset, "WrongExpirationTimestamp");
    });

    it("2.5 refuses a term shorter than the minimum", async () => {
      const holdId = await pledge(VESTED, 2 * DAY);
      await expect(pool.connect(borrower).borrow(PARTITION, holdId, USDC(100))).to.be.revertedWithCustomError(
        pool,
        "HoldTermTooShort",
      );
    });

    it("2.6 refuses to lend more than the pool holds", async () => {
      await pool.connect(admin).removeLiquidity(admin.address, USDC(99_000));
      const holdId = await pledge(VESTED);
      await expect(pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000))).to.be.revertedWithCustomError(
        pool,
        "InsufficientLiquidity",
      );
    });

    it("2.7 the same hold cannot back two loans", async () => {
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(2_000));
      await expect(pool.connect(borrower).borrow(PARTITION, holdId, USDC(2_000))).to.be.revertedWithCustomError(
        pool,
        "CollateralAlreadyPledged",
      );
    });
  });

  describe("3. Repayment", () => {
    it("3.1 interest accrues, and full repayment releases the collateral", async () => {
      const holdId = await pledge(VESTED, 500 * DAY);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));

      await time.increase(365 * DAY);
      const owed = await pool.debtOf(1);
      expect(owed).to.be.closeTo(USDC(5_400), USDC(1)); // 8% APR

      await usdc.mint(borrower.address, USDC(1_000));
      await usdc.connect(borrower).approve(poolAddress, MAX_UINT256.toString());
      // repayAll, not repay(owed): interest accrues per second, so a figure read off-chain
      // is already short by the time the transaction mines.
      await pool.connect(borrower).repayAll(1);

      expect(Number((await pool.getLoan(1)).status)).to.equal(2); // Repaid
      expect(await asset.getHeldAmountForByPartition(PARTITION, borrower.address)).to.equal(0);
      expect(await asset.balanceOfByPartition(PARTITION, borrower.address)).to.equal(VESTED);
    });

    it("3.2 a partial repayment reduces the debt and keeps the collateral held", async () => {
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));

      await usdc.connect(borrower).approve(poolAddress, MAX_UINT256.toString());
      await pool.connect(borrower).repay(1, USDC(2_000));

      expect(await pool.debtOf(1)).to.be.closeTo(USDC(3_000), USDC(1));
      expect(Number((await pool.getLoan(1)).status)).to.equal(1); // still Active
      expect(await asset.getHeldAmountForByPartition(PARTITION, borrower.address)).to.equal(VESTED);
    });

    it("3.3 offering more than is owed takes only the debt, and closes the loan", async () => {
      // Interest accrues per second, so anyone aiming at the exact figure is guessing at
      // what it will be when the transaction mines. Reverting on an overshoot would make
      // undershooting — which silently leaves the loan open — the safer mistake.
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));
      await usdc.mint(borrower.address, USDC(10_000));
      await usdc.connect(borrower).approve(poolAddress, MAX_UINT256.toString());

      const before = await usdc.balanceOf(borrower.address);
      const owed = await pool.debtOf(1);
      await pool.connect(borrower).repay(1, USDC(9_000));

      expect(Number((await pool.getLoan(1)).status)).to.equal(2); // Repaid
      // Only the debt left their wallet, not the 9,000 offered.
      expect(before - (await usdc.balanceOf(borrower.address))).to.be.closeTo(owed, USDC(0.01));
      expect(await asset.getHeldAmountForByPartition(PARTITION, borrower.address)).to.equal(0);
    });

    it("3.4 a repaid loan cannot be repaid or liquidated again", async () => {
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));
      await usdc.mint(borrower.address, USDC(100)); // interest, however little has accrued
      await usdc.connect(borrower).approve(poolAddress, MAX_UINT256.toString());
      await pool.connect(borrower).repayAll(1);

      await expect(pool.connect(borrower).repay(1, USDC(1))).to.be.revertedWithCustomError(pool, "LoanNotActive");
      await expect(pool.connect(keeper).liquidate(1)).to.be.revertedWithCustomError(pool, "LoanNotActive");
    });
  });

  describe("4. Liquidation", () => {
    it("4.1 a healthy loan cannot be liquidated", async () => {
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));
      await expect(pool.connect(keeper).liquidate(1)).to.be.revertedWithCustomError(pool, "Healthy");
    });

    it("4.2 a NAV collapse makes it seizable, and anyone can trigger it", async () => {
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));

      // $2.00 -> $1.00 halves the collateral, taking LTV from 25% to 50%.
      await nav.publish(1_00000000n, "down round");
      expect(await pool.ltvOf(1)).to.be.greaterThan(4_000);

      await expect(pool.connect(keeper).liquidate(1)).to.not.be.reverted;
      expect(Number((await pool.getLoan(1)).status)).to.equal(3); // Liquidated
    });

    it("4.3 liquidation takes only what covers the debt and returns the surplus", async () => {
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));
      await nav.publish(1_00000000n, "down round");

      const debt = await pool.debtOf(1);
      await pool.connect(keeper).liquidate(1);

      // At $1.00 a share, ~5,000 shares cover a ~$5,000 debt; the rest goes back.
      const taken = Number(await asset.balanceOfByPartition(PARTITION, poolAddress));
      const returned = Number(await asset.balanceOfByPartition(PARTITION, borrower.address));
      expect(taken).to.be.closeTo(Math.ceil(Number(debt) / 1e6), 2);
      expect(taken + returned).to.equal(VESTED);
      expect(await asset.getHeldAmountForByPartition(PARTITION, borrower.address)).to.equal(0);
    });

    it("4.4 a matured loan is seizable even while healthy", async () => {
      // The loan can never outlive its collateral: past the hold's expiry the borrower
      // could reclaim it, so maturity has to be enforceable regardless of health.
      const holdId = await pledge(VESTED, 30 * DAY);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(1_000));
      expect(await pool.ltvOf(1)).to.be.lessThan(4_000);

      // Maturity lands three days BEFORE the hold expires, because ATS refuses to execute an
      // expired hold. Seizing has to happen inside that window or not at all.
      const loan = await pool.getLoan(1);
      expect(Number(loan.maturity)).to.be.closeTo((await time.latest()) + 27 * DAY, 5);

      await time.increaseTo(Number(loan.maturity) + 1);
      // The peg feed has a 2-day heartbeat, so 27 days of time travel leaves it stale. A
      // live Chainlink feed refreshes itself; here we do it by hand.
      await peg.publish(PEG_8DP, "heartbeat");
      await expect(pool.connect(keeper).liquidate(1)).to.not.be.reverted;
    });

    it("4.6 a stale price pauses liquidation, deliberately", async () => {
      // Seizing somebody's equity on a price nobody can vouch for is worse than waiting.
      // The operational answer is to keep the feed alive, not to seize on stale data — the
      // same call Aave makes. Worth pinning, because it means oracle liveness is a
      // solvency concern, not just a UX one.
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));
      await nav.publish(1_00000000n, "down round");

      await time.increase(3 * DAY); // past the peg feed's 2-day heartbeat
      await expect(pool.connect(keeper).liquidate(1)).to.be.revertedWithCustomError(pool, "StalePrice");

      await peg.publish(PEG_8DP, "heartbeat");
      await expect(pool.connect(keeper).liquidate(1)).to.not.be.reverted;
    });

    it("4.5 liquidating twice reverts", async () => {
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));
      await nav.publish(1_00000000n, "down round");
      await pool.connect(keeper).liquidate(1);
      await expect(pool.connect(keeper).liquidate(1)).to.be.revertedWithCustomError(pool, "LoanNotActive");
    });
  });

  describe("5. The issuer keeps control of pledged equity", () => {
    it("5.1 a suspended borrower cannot be liquidated INTO a compliance failure", async () => {
      // Freezing the borrower blocks transfers, so liquidation reverts rather than
      // quietly bypassing the compliance stack. Worth knowing: suspension and liquidation
      // interact, and the token wins.
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));
      await nav.publish(1_00000000n, "down round");

      await executeRbac(asset, [{ role: ATS_ROLES.ROLE_FREEZE_MANAGER, members: [admin.address] }]);
      await asset.connect(admin).setAddressFrozen(borrower.address, true);

      await expect(pool.connect(keeper).liquidate(1)).to.be.reverted;

      await asset.connect(admin).setAddressFrozen(borrower.address, false);
      await expect(pool.connect(keeper).liquidate(1)).to.not.be.reverted;
    });

    it("5.2 collateral is valued from the CURRENT held amount, not one recorded at borrow", async () => {
      // Phase 2's split-adjustment trap, in the place it would hurt most: valuing a loan
      // from a stale figure would under-collateralise it exactly when shares multiplied.
      const holdId = await pledge(VESTED);
      await pool.connect(borrower).borrow(PARTITION, holdId, USDC(5_000));
      const before = await pool.ltvOf(1);

      await executeRbac(asset, [{ role: ATS_ROLES.ROLE_ADJUSTMENT_BALANCE, members: [admin.address] }]);
      await asset.connect(admin).adjustBalances(2, 0); // 2-for-1 split

      // Twice the shares at the same price per share means half the LTV. If the pool were
      // reading a stored amount, this would not move at all.
      expect(await pool.ltvOf(1)).to.be.closeTo(Number(before) / 2, 2);
    });
  });
});
