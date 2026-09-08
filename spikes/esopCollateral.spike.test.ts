// SPDX-License-Identifier: Apache-2.0
//
// SPIKE #1 for tokenize-it: can an ATS hold be used as loan collateral where the
// lending pool is a plain contract/EOA that the issuer has NOT KYC'd?
//
// employee  = signer_A  (KYC'd, holds the vested ESOP tokens)
// pool      = signer_D  (the lending pool -- deliberately NOT KYC'd)
// kycAdmin  = signer_B  (ROLE_KYC + ROLE_ISSUER)
// listAdmin = signer_E  (ROLE_CONTROL_LIST)

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import { deployEquityTokenFixture, executeRbac, MAX_UINT256 } from "@test";
import { EMPTY_STRING, ATS_ROLES, ZERO, EMPTY_HEX_BYTES } from "@scripts";
import { ResolverProxy, IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const AMOUNT = 1000;
const COLLATERAL = 400;
const ONE_YEAR = 365 * 24 * 60 * 60;

describe("SPIKE: ESOP hold-as-collateral vs KYC/allowlist", () => {
  let diamond: ResolverProxy;
  let asset: IAsset;
  let employee: HardhatEthersSigner; // signer_A
  let kycAdmin: HardhatEthersSigner; // signer_B
  let other: HardhatEthersSigner; // signer_C (KYC'd control)
  let pool: HardhatEthersSigner; // signer_D -- NOT KYC'd
  let listAdmin: HardhatEthersSigner; // signer_E
  let expiration: number;

  function rbacs() {
    return [
      { role: ATS_ROLES.ROLE_ISSUER, members: [kycAdmin.address] },
      { role: ATS_ROLES.ROLE_KYC, members: [kycAdmin.address] },
      { role: ATS_ROLES.ROLE_SSI_MANAGER, members: [employee.address] },
      { role: ATS_ROLES.ROLE_CONTROL_LIST, members: [listAdmin.address] },
      { role: ATS_ROLES.ROLE_CONTROLLER, members: [other.address] },
    ];
  }

  async function setup(isWhiteList: boolean) {
    const base = await deployEquityTokenFixture({
      equityDataParams: {
        securityData: { isMultiPartition: true, isWhiteList, isControllable: true },
      },
      useLoadFixture: false,
    });
    diamond = base.diamond;
    employee = base.deployer;
    kycAdmin = base.user1;
    other = base.user2;
    pool = base.user3;
    listAdmin = base.user4;

    asset = await ethers.getContractAt("IAsset", diamond.target);
    await executeRbac(asset, rbacs());

    await asset.connect(employee).addIssuer(employee.address);
    // KYC the employee and one control address -- deliberately NOT the pool.
    for (const who of [employee, kycAdmin, other]) {
      await asset.connect(kycAdmin).grantKyc(who.address, EMPTY_STRING, ZERO, MAX_UINT256, employee.address);
    }

    if (isWhiteList) {
      // Allowlist mode: everyone who touches the token must be listed. Pool stays off.
      for (const who of [employee, kycAdmin, other]) {
        await asset.connect(listAdmin).addToControlList(who.address);
      }
    }

    await asset.connect(kycAdmin).issueByPartition({
      partition: PARTITION,
      tokenHolder: employee.address,
      value: AMOUNT,
      data: EMPTY_HEX_BYTES,
    });

    expiration = (await ethers.provider.getBlock("latest"))!.timestamp + ONE_YEAR;
  }

  function holdPayload(to: string, escrow: string) {
    return {
      amount: COLLATERAL,
      expirationTimestamp: expiration,
      escrow,
      to,
      data: EMPTY_HEX_BYTES,
    };
  }

  const identifier = (holdId: number) => ({
    partition: PARTITION,
    tokenHolder: employee.address,
    holdId,
  });

  describe("A. blocklist mode (isWhiteList=false) -- isolates the KYC check", () => {
    beforeEach(async () => await setup(false));

    it("A1. createHoldByPartition SUCCEEDS with a non-KYC'd pool as escrow+destination", async () => {
      await expect(asset.connect(employee).createHoldByPartition(PARTITION, holdPayload(pool.address, pool.address)))
        .to.not.be.reverted;

      const held = await asset.getHeldAmountForByPartition(PARTITION, employee.address);
      expect(held).to.equal(COLLATERAL);
      // Collateral is debited from spendable balance but still owned by the employee.
      expect(await asset.balanceOf(employee.address)).to.equal(AMOUNT - COLLATERAL);
    });

    it("A2. releaseHoldByPartition (the REPAY path) SUCCEEDS even though the escrow is not KYC'd", async () => {
      await asset.connect(employee).createHoldByPartition(PARTITION, holdPayload(pool.address, pool.address));
      await expect(asset.connect(pool).releaseHoldByPartition(identifier(1), COLLATERAL)).to.not.be.reverted;
      expect(await asset.balanceOf(employee.address)).to.equal(AMOUNT);
    });

    it("A3. executeHoldByPartition (the LIQUIDATION path) FAILS to a non-KYC'd pool", async () => {
      await asset.connect(employee).createHoldByPartition(PARTITION, holdPayload(pool.address, pool.address));
      await expect(
        asset.connect(pool).executeHoldByPartition(identifier(1), pool.address, COLLATERAL),
      ).to.be.revertedWithCustomError(asset, "InvalidKycStatus");
    });

    it("A4. executeHoldByPartition SUCCEEDS once the pool is KYC'd -> this is the fix", async () => {
      await asset.connect(employee).createHoldByPartition(PARTITION, holdPayload(pool.address, pool.address));
      await asset.connect(kycAdmin).grantKyc(pool.address, EMPTY_STRING, ZERO, MAX_UINT256, employee.address);
      await expect(asset.connect(pool).executeHoldByPartition(identifier(1), pool.address, COLLATERAL)).to.not.be
        .reverted;
      expect(await asset.balanceOf(pool.address)).to.equal(COLLATERAL);
    });

    it("A5. FALLBACK: liquidating to a KYC'd treasury instead of the pool SUCCEEDS", async () => {
      // escrow = pool (uncleared), destination = `other` (KYC'd treasury)
      await asset.connect(employee).createHoldByPartition(PARTITION, holdPayload(other.address, pool.address));
      await expect(asset.connect(pool).executeHoldByPartition(identifier(1), other.address, COLLATERAL)).to.not.be
        .reverted;
      expect(await asset.balanceOf(other.address)).to.equal(COLLATERAL);
    });
  });

  describe("B. allowlist mode (isWhiteList=true) -- our production config", () => {
    beforeEach(async () => await setup(true));

    it("B1. createHoldByPartition still SUCCEEDS with an unlisted, non-KYC'd pool", async () => {
      await expect(asset.connect(employee).createHoldByPartition(PARTITION, holdPayload(pool.address, pool.address)))
        .to.not.be.reverted;
      expect(await asset.getHeldAmountForByPartition(PARTITION, employee.address)).to.equal(COLLATERAL);
    });

    it("B2. executeHoldByPartition FAILS when the pool is KYC'd but NOT allowlisted", async () => {
      await asset.connect(employee).createHoldByPartition(PARTITION, holdPayload(pool.address, pool.address));
      await asset.connect(kycAdmin).grantKyc(pool.address, EMPTY_STRING, ZERO, MAX_UINT256, employee.address);
      await expect(asset.connect(pool).executeHoldByPartition(identifier(1), pool.address, COLLATERAL)).to.be.reverted;
    });

    it("B3. executeHoldByPartition SUCCEEDS when the pool is BOTH KYC'd and allowlisted", async () => {
      await asset.connect(employee).createHoldByPartition(PARTITION, holdPayload(pool.address, pool.address));
      await asset.connect(kycAdmin).grantKyc(pool.address, EMPTY_STRING, ZERO, MAX_UINT256, employee.address);
      await asset.connect(listAdmin).addToControlList(pool.address);
      await expect(asset.connect(pool).executeHoldByPartition(identifier(1), pool.address, COLLATERAL)).to.not.be
        .reverted;
      expect(await asset.balanceOf(pool.address)).to.equal(COLLATERAL);
    });
  });

  describe("C. can the issuer still freeze/claw back collateral that is under hold?", () => {
    beforeEach(async () => await setup(false));

    it("C1. held collateral is still visible to the issuer as part of the employee position", async () => {
      await asset.connect(employee).createHoldByPartition(PARTITION, holdPayload(pool.address, pool.address));
      expect(await asset.getHeldAmountForByPartition(PARTITION, employee.address)).to.equal(COLLATERAL);
      expect(await asset.balanceOfByPartition(PARTITION, employee.address)).to.equal(AMOUNT - COLLATERAL);
    });

    it("C2. controllerRedeemByPartition CANNOT reach tokens locked under a hold", async () => {
      await asset.connect(employee).createHoldByPartition(PARTITION, holdPayload(pool.address, pool.address));
      // try to claw back more than the free balance
      await expect(
        asset
          .connect(other)
          .controllerRedeemByPartition(PARTITION, employee.address, AMOUNT, EMPTY_HEX_BYTES, EMPTY_HEX_BYTES),
      ).to.be.reverted;
    });
  });
});
