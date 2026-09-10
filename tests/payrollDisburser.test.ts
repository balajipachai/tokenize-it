// SPDX-License-Identifier: Apache-2.0
import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import { deployEquityTokenFixture, executeRbac, MAX_UINT256 } from "@test";
import { EMPTY_STRING, ATS_ROLES, ZERO } from "@scripts";
import { IAsset } from "@contract-types";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

describe("PHASE 7: PayrollDisburser", () => {
  let asset: IAsset;
  let usdc: any;
  let payroll: any;
  let payrollAddress: string;

  let admin: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let relayer: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  beforeEach(async () => {
    const base = await deployEquityTokenFixture({
      equityDataParams: {
        securityData: {
          maxSupply: 1_000_000,
          isMultiPartition: true,
          isControllable: true,
          internalKycActivated: true,
          isWhiteList: true,
          arePartitionsProtected: false,
          clearingActive: false,
        },
      },
    });
    admin = base.deployer;
    treasury = base.user1;
    alice = base.user2;
    bob = base.user3;
    [, , , , relayer, outsider] = await ethers.getSigners();

    asset = await ethers.getContractAt("IAsset", base.diamond.target);

    const USDCFactory = await ethers.getContractFactory("MockUSDC");
    usdc = await USDCFactory.deploy();
    await usdc.waitForDeployment();

    await executeRbac(asset, [
      { role: ATS_ROLES.ROLE_KYC, members: [admin.address] },
      { role: ATS_ROLES.ROLE_CONTROL_LIST, members: [admin.address] },
      { role: ATS_ROLES.ROLE_SSI_MANAGER, members: [admin.address] },
    ]);
    await asset.connect(admin).addIssuer(admin.address);

    // Alice and Bob are onboarded employees. `outsider` deliberately is not.
    for (const who of [alice.address, bob.address]) {
      await asset.connect(admin).grantKyc(who, EMPTY_STRING, ZERO, MAX_UINT256, admin.address);
      await asset.connect(admin).addToControlList(who);
    }

    const Payroll = await ethers.getContractFactory("PayrollDisburser");
    payroll = await Payroll.deploy(await usdc.getAddress(), base.diamond.target, treasury.address, admin.address);
    await payroll.waitForDeployment();
    payrollAddress = await payroll.getAddress();

    await payroll.connect(admin).setPayoutRelayer(relayer.address, true);
    await usdc.mint(treasury.address, USDC(1_000_000));
    await usdc.connect(treasury).approve(payrollAddress, MAX_UINT256);
  });

  describe("1. Running payroll", () => {
    it("1.1 credits each employee and pulls the total ONCE", async () => {
      const before = await usdc.balanceOf(treasury.address);
      await payroll.connect(treasury).fundRun([alice.address, bob.address], [USDC(5_000), USDC(3_000)]);

      expect(await payroll.accrued(alice.address)).to.equal(USDC(5_000));
      expect(await payroll.accrued(bob.address)).to.equal(USDC(3_000));
      expect(await payroll.totalAccrued()).to.equal(USDC(8_000));
      // Exactly the sum left the treasury, in one movement.
      expect(before - (await usdc.balanceOf(treasury.address))).to.equal(USDC(8_000));
      expect(await usdc.balanceOf(payrollAddress)).to.equal(USDC(8_000));
    });

    it("1.2 salary is NOT pushed -- nobody is paid until it is delivered", async () => {
      await payroll.connect(treasury).fundRun([alice.address], [USDC(5_000)]);
      // The whole point of accrual: a run cannot fail on one recipient's transfer.
      expect(await usdc.balanceOf(alice.address)).to.equal(0);
      expect(await payroll.accrued(alice.address)).to.equal(USDC(5_000));
    });

    it("1.3 only the treasury can run payroll", async () => {
      await expect(
        payroll.connect(outsider).fundRun([alice.address], [USDC(1)]),
      ).to.be.revertedWithCustomError(payroll, "NotTreasury");
      await expect(
        payroll.connect(admin).fundRun([alice.address], [USDC(1)]),
      ).to.be.revertedWithCustomError(payroll, "NotTreasury");
    });

    it("1.4 THE COMPLIANCE TIE: payroll cannot pay someone off the allowlist", async () => {
      await expect(
        payroll.connect(treasury).fundRun([alice.address, outsider.address], [USDC(1_000), USDC(1_000)]),
      ).to.be.revertedWithCustomError(payroll, "NotAllowlisted");
      // The whole run is refused rather than quietly dropping them.
      expect(await payroll.accrued(alice.address)).to.equal(0);
      expect(await payroll.totalAccrued()).to.equal(0);
    });

    it("1.5 a suspended employee stops being payable", async () => {
      await payroll.connect(treasury).fundRun([alice.address], [USDC(1_000)]);
      await asset.connect(admin).removeFromControlList(alice.address);
      await expect(
        payroll.connect(treasury).fundRun([alice.address], [USDC(1_000)]),
      ).to.be.revertedWithCustomError(payroll, "NotAllowlisted");
      // Already-earned salary is untouched -- suspension stops future pay, it does not confiscate.
      expect(await payroll.accrued(alice.address)).to.equal(USDC(1_000));
    });

    it("1.6 rejects a malformed run", async () => {
      await expect(payroll.connect(treasury).fundRun([], [])).to.be.revertedWithCustomError(payroll, "EmptyRun");
      await expect(
        payroll.connect(treasury).fundRun([alice.address, bob.address], [USDC(1)]),
      ).to.be.revertedWithCustomError(payroll, "LengthMismatch");
      await expect(
        payroll.connect(treasury).fundRun([alice.address], [0]),
      ).to.be.revertedWithCustomError(payroll, "ZeroAmount");
    });

    it("1.7 accrues across runs and keeps a lifetime record", async () => {
      await payroll.connect(treasury).fundRun([alice.address], [USDC(5_000)]);
      await payroll.connect(treasury).fundRun([alice.address], [USDC(5_000)]);
      expect(await payroll.accrued(alice.address)).to.equal(USDC(10_000));
      expect(await payroll.lifetimeEarned(alice.address)).to.equal(USDC(10_000));
    });
  });

  describe("2. Getting paid", () => {
    beforeEach(async () => {
      await payroll.connect(treasury).fundRun([alice.address, bob.address], [USDC(5_000), USDC(3_000)]);
    });

    it("2.1 an employee can collect their own salary", async () => {
      await payroll.connect(alice).withdraw();
      expect(await usdc.balanceOf(alice.address)).to.equal(USDC(5_000));
      expect(await payroll.accrued(alice.address)).to.equal(0);
      expect(await payroll.totalAccrued()).to.equal(USDC(3_000));
    });

    it("2.2 THE GASLESS PATH: a relayer delivers, and only ever to the employee", async () => {
      await payroll.connect(relayer).withdrawFor(alice.address);
      expect(await usdc.balanceOf(alice.address)).to.equal(USDC(5_000));
      // The relayer carried the transaction and received nothing.
      expect(await usdc.balanceOf(relayer.address)).to.equal(0);
    });

    it("2.3 a stranger cannot trigger someone else's payout", async () => {
      await expect(
        payroll.connect(outsider).withdrawFor(alice.address),
      ).to.be.revertedWithCustomError(payroll, "NotEntitled");
    });

    it("2.4 lifetime earnings survive withdrawal -- it is a payslip history", async () => {
      await payroll.connect(alice).withdraw();
      expect(await payroll.lifetimeEarned(alice.address)).to.equal(USDC(5_000));
    });

    it("2.5 withdrawing twice reverts rather than paying twice", async () => {
      await payroll.connect(alice).withdraw();
      await expect(payroll.connect(alice).withdraw()).to.be.revertedWithCustomError(payroll, "NothingAccrued");
    });

    it("2.6 one employee collecting does not touch another's balance", async () => {
      await payroll.connect(alice).withdraw();
      expect(await payroll.accrued(bob.address)).to.equal(USDC(3_000));
      expect(await usdc.balanceOf(bob.address)).to.equal(0);
      await payroll.connect(bob).withdraw();
      expect(await usdc.balanceOf(bob.address)).to.equal(USDC(3_000));
    });

    it("2.7 a suspended employee can still collect what they already earned", async () => {
      await asset.connect(admin).removeFromControlList(alice.address);
      await payroll.connect(alice).withdraw();
      expect(await usdc.balanceOf(alice.address)).to.equal(USDC(5_000));
    });
  });

  describe("3. Solvency", () => {
    it("3.1 stays solvent and carries no surplus in normal operation", async () => {
      await payroll.connect(treasury).fundRun([alice.address], [USDC(5_000)]);
      expect(await payroll.isSolvent()).to.equal(true);
      expect(await payroll.surplus()).to.equal(0);
      await payroll.connect(alice).withdraw();
      expect(await payroll.totalAccrued()).to.equal(0);
      expect(await payroll.isSolvent()).to.equal(true);
    });

    it("3.2 a stray transfer shows up as surplus rather than silently inflating payroll", async () => {
      await payroll.connect(treasury).fundRun([alice.address], [USDC(5_000)]);
      await usdc.mint(payrollAddress, USDC(42));
      expect(await payroll.surplus()).to.equal(USDC(42));
      // It does not become anybody's salary.
      expect(await payroll.accrued(alice.address)).to.equal(USDC(5_000));
    });
  });

  describe("4. Administration", () => {
    it("4.1 the treasury can be rotated, and the old one loses the ability to run payroll", async () => {
      await payroll.connect(admin).setTreasury(bob.address);
      await expect(
        payroll.connect(treasury).fundRun([alice.address], [USDC(1)]),
      ).to.be.revertedWithCustomError(payroll, "NotTreasury");
    });

    it("4.2 admin transfer is two-step, so a typo cannot strand the role", async () => {
      await payroll.connect(admin).transferAdmin(bob.address);
      // Still the old admin until accepted.
      await expect(payroll.connect(bob).setTreasury(bob.address)).to.be.revertedWithCustomError(payroll, "NotAdmin");
      await payroll.connect(bob).acceptAdmin();
      await payroll.connect(bob).setTreasury(alice.address);
      expect(await payroll.treasury()).to.equal(alice.address);
    });

    it("4.3 only the admin appoints payout relayers", async () => {
      await expect(
        payroll.connect(outsider).setPayoutRelayer(outsider.address, true),
      ).to.be.revertedWithCustomError(payroll, "NotAdmin");
    });
  });
});
