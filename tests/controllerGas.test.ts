// SPDX-License-Identifier: Apache-2.0
//
// Real gas for the controller's hot paths, so optimisation claims are checked against
// this contract rather than against a rule of thumb.

import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployEquityTokenFixture, executeRbac, MAX_UINT256 } from "@test";
import { EMPTY_STRING, ATS_ROLES, ZERO, EMPTY_HEX_BYTES } from "@scripts";
import { IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const POOL = 1_000_000;
const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;
const MONTH = 30 * DAY;
const CLIFF = 1_200;
const MONTHLY = 100;
const COUNT = 36;

describe("GAS: ESOPVestingController hot paths", () => {
  let asset: IAsset;
  let controller: any;
  let admin: HardhatEthersSigner;
  let hr: HardhatEthersSigner;
  let priya: HardhatEthersSigner;
  let bystander: HardhatEthersSigner;
  let start: number;

  beforeEach(async () => {
    const base = await deployEquityTokenFixture({
      equityDataParams: {
        securityData: {
          maxSupply: POOL,
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
    bystander = base.user4;

    asset = await ethers.getContractAt("IAsset", base.diamond.target);
    const Factory = await ethers.getContractFactory("ESOPVestingController");
    controller = await Factory.deploy(base.diamond.target, hr.address);
    await controller.waitForDeployment();
    const addr = await controller.getAddress();

    await executeRbac(asset, [
      { role: ATS_ROLES.ROLE_ISSUER, members: [admin.address] },
      { role: ATS_ROLES.ROLE_KYC, members: [admin.address] },
      { role: ATS_ROLES.ROLE_CONTROL_LIST, members: [admin.address] },
      { role: ATS_ROLES.ROLE_SSI_MANAGER, members: [admin.address] },
      { role: ATS_ROLES.ROLE_LOCKER, members: [addr] },
      { role: ATS_ROLES.ROLE_CONTROLLER, members: [addr] },
      { role: ATS_ROLES.ROLE_WILD_CARD, members: [addr] },
    ]);
    await asset.connect(admin).addIssuer(admin.address);
    for (const who of [admin.address, addr, priya.address]) {
      await asset.connect(admin).grantKyc(who, EMPTY_STRING, ZERO, MAX_UINT256, admin.address);
      await asset.connect(admin).addToControlList(who);
    }
    await asset.connect(admin).issueByPartition({
      partition: PARTITION,
      tokenHolder: addr,
      value: POOL,
      data: EMPTY_HEX_BYTES,
    });

    start = await time.latest();
    const amounts = [CLIFF];
    const dates = [start + YEAR];
    for (let i = 1; i <= COUNT; i++) {
      amounts.push(MONTHLY);
      dates.push(start + YEAR + i * MONTH);
    }
    await controller.connect(hr).createGrant(priya.address, PARTITION, amounts, dates);
    for (;;) {
      await controller.connect(hr).fundTranches(1, 20);
      if (Number((await controller.getGrant(1)).status) === 2) break;
    }
  });

  it("releaseVested + clawback, 12 tranches each", async () => {
    await time.increaseTo(start + YEAR + 11 * MONTH + 1);
    const release = await (await controller.connect(bystander).releaseVested(1, 12)).wait();

    await controller.connect(hr).terminate(1, 2, await time.latest());
    const claw = await (await controller.connect(hr).clawback(1, 12)).wait();

    console.log(`        releaseVested(12) : ${release.gasUsed}`);
    console.log(`        clawback(12)      : ${claw.gasUsed}`);
  });
});
