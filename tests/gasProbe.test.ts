// SPDX-License-Identifier: Apache-2.0
//
// Settles "should these structs be loaded into memory first?" by measuring it on
// ESOPVestingController's exact struct layouts, rather than applying the general
// read-once/write-once rule and hoping it transfers.

import { ethers } from "hardhat";

const TRANCHES = 13;

describe("GAS: storage pointer vs memory copy", () => {
  let probe: any;

  async function gasOf(fn: () => Promise<any>): Promise<bigint> {
    const rc = await (await fn()).wait();
    return rc.gasUsed;
  }

  beforeEach(async () => {
    const Probe = await ethers.getContractFactory("GasProbe");
    probe = await Probe.deploy();
    await probe.waitForDeployment();
    await (await probe.seed(1, TRANCHES)).wait();
    await (await probe.seed(2, TRANCHES)).wait();
    await (await probe.seed(3, TRANCHES)).wait();
    await (await probe.warm()).wait(); // otherwise the first measurement pays 20k extra
  });

  it("A. terminate(): three writes into ONE packed slot", async () => {
    const viaStorage = await gasOf(() => probe.terminateViaStorage(1, 1000));
    const viaMemory = await gasOf(() => probe.terminateViaMemory(2, 1000));
    console.log(`        storage pointer : ${viaStorage}`);
    console.log(`        memory copy     : ${viaMemory}  (${viaMemory - viaStorage > 0n ? "+" : ""}${viaMemory - viaStorage})`);
  });

  it("B. reading 2 fields out of a 4-slot struct", async () => {
    const viaStorage = await gasOf(() => probe.readViaStorage(1));
    const viaMemory = await gasOf(() => probe.readViaMemory(2));
    console.log(`        storage pointer : ${viaStorage}`);
    console.log(`        memory copy     : ${viaMemory}  (${viaMemory - viaStorage > 0n ? "+" : ""}${viaMemory - viaStorage})`);
  });

  it("C. the release loop over 13 tranches", async () => {
    const viaStorage = await gasOf(() => probe.loopViaStorage(1, 20));
    const cached = await gasOf(() => probe.loopCached(2, 20));
    const viaMemory = await gasOf(() => probe.loopViaMemoryWriteback(3, 20));
    console.log(`        storage pointer      : ${viaStorage}`);
    console.log(`        cached + packed read : ${cached}  (${cached - viaStorage > 0n ? "+" : ""}${cached - viaStorage})`);
    console.log(`        full memory copy     : ${viaMemory}  (${viaMemory - viaStorage > 0n ? "+" : ""}${viaMemory - viaStorage})`);
  });
});
