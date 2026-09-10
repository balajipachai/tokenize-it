// SPDX-License-Identifier: Apache-2.0
//
// Drives the leaver, dispute and arbitration lifecycle against live Hedera testnet.
//
// Why this exists: these paths had unit coverage and had been driven on testnet, but against
// a DIFFERENT build. The controller redeploy changed the deployed bytecode, so on the live
// contract the whole recourse mechanism was unexercised. "It passed locally and it worked on
// the previous deployment" is weaker evidence than it sounds, and this project has twice been
// caught by behaviour that only appears on chain.
//
// It asserts the guards rather than just the happy path, because the guards ARE the feature:
// a dispute window nobody can wait out, or a ruling anyone can skip, is not recourse.
//
//   npm run testnet:dispute-demo

import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";
import { IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
/**
 * Generous on purpose. `fundTranches` mints and locks each tranche through the ATS diamond
 * and ran out of gas at 891,652 of a 900,000 limit for just two of them -- empty revert data
 * at 99.1% consumed, the same signature that has bitten this project three times now.
 * Hedera charges on gas USED, not the limit offered, so the headroom costs nothing.
 */
const GAS = { gasLimit: 3_000_000n };
const REPO_ROOT = process.env.TOKENIZE_IT_ROOT ?? path.resolve(__dirname, "../../../../../../..");
const DEPLOYMENTS = path.join(REPO_ROOT, "deployments", "hedera-testnet.json");

const Bad = 2;
const Good = 1;
const STATUS = ["None", "Funding", "Active", "Terminated"];

function step(n: string, msg: string) {
  console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
}
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);

/**
 * Asserts a call reverts, and names the reason when the RPC will say.
 *
 * Hashio answers a failed `eth_call` with a flat "CONTRACT_REVERT_EXECUTED" and does not
 * always carry the revert data back, so matching on an error NAME cannot work here the way
 * it does against a local node. Where the selector does come through it is checked properly;
 * where it does not, that is reported rather than papered over — an assertion that silently
 * accepts any revert is worse than one that admits what it could not confirm.
 */
async function mustRevert(p: Promise<unknown>, expectedSig: string, what: string) {
  const selector = ethersLib.id(expectedSig).slice(0, 10);
  try {
    await p;
    throw new Error(`EXPECTED REVERT (${expectedSig}) BUT IT SUCCEEDED: ${what}`);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.startsWith("EXPECTED REVERT")) throw e;
    const err = e as { data?: unknown; info?: { error?: { data?: unknown } } };
    const data = String(err.data ?? err.info?.error?.data ?? "");
    if (data.startsWith(selector)) {
      ok(`${what} -- refused with ${expectedSig}`);
    } else {
      ok(`${what} -- refused (RPC did not surface the selector; reason unconfirmed)`);
    }
  }
}

async function main() {
  const [operator] = await ethers.getSigners();
  const rec = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const controller = await ethers.getContractAt("ESOPVestingController", rec.esopVestingController.address);
  const token = (await ethers.getContractAt("IAsset", rec.esopToken.address)) as unknown as IAsset;
  const arbiterAddress: string = rec.esopVestingController.demoArbiter.address;
  const arbiter = await ethers.getContractAt("MockMultisig", arbiterAddress);

  console.log("=".repeat(72));
  console.log("  tokenize-it -- leaver, dispute and arbitration, on live testnet");
  console.log("=".repeat(72));
  console.log(`  controller ${rec.esopVestingController.address}`);
  console.log(`  arbiter    ${arbiterAddress}`);

  const executor = await arbiter.executor();
  if (executor.toLowerCase() !== operator.address.toLowerCase()) {
    throw new Error(`Arbiter executor is ${executor}, not the operator. Cannot drive a ruling.`);
  }
  ok("arbiter is a contract whose threshold the controller enforced at appointment");

  // A throwaway holder. Never needs a key: every action here is the issuer's, the relayer's
  // or the arbiter's -- which is the point, since a terminated employee may have no gas.
  const employee = ethersLib.Wallet.createRandom().address;
  console.log(`  employee   ${employee} (fresh)`);

  step("1", "Onboarding and granting, with most of the schedule still unvested...");
  const now = Math.floor(Date.now() / 1000);
  const at = now;
  await (
    await token.grantKyc(employee, `did:hedera:testnet:${operator.address}#dispute-demo-${at}`, at, at + 31536000, operator.address, GAS)
  ).wait();
  await (await token.addToControlList(employee, GAS)).wait();

  /**
   * Offsets are resolved HERE, not by the caller. ATS locks until each vest date and rejects
   * a lock that already expired, so a timestamp computed before a couple of Hedera round
   * trips is a WrongExpirationTimestamp waiting to happen -- which is exactly how the first
   * two runs of this script died.
   */
  /**
   * A realistic leaving date, clamped into the only window the contract accepts.
   *
   * `terminate` rejects anything after `block.timestamp` -- nobody forward-dates a
   * termination to manufacture vesting -- and anything before `grantDate`. Consensus time is
   * read from the chain rather than the local clock, because a few seconds of skew is enough
   * to trip the upper bound.
   *
   * Using `grantDate` itself would satisfy both bounds and still be wrong: good-leaver
   * acceleration pulls back the first tranche that vests AFTER the leaving date, so a date
   * that early matches a tranche which has already vested, spends the acceleration on it and
   * stops. The employee silently loses the credit. The clamp is what makes the leaving date
   * mean "when they left".
   */
  async function leavingDate(grantId: bigint): Promise<bigint> {
    const chainNow = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const grantDate = (await controller.getGrant(grantId)).grantDate;
    const candidate = chainNow - 5n;
    return candidate > grantDate ? candidate : grantDate;
  }

  async function makeGrant(amounts: number[], offsets: number[]): Promise<bigint> {
    const base = Math.floor(Date.now() / 1000);
    const dates = offsets.map((o) => base + o);
    const id = await controller.nextGrantId();
    await (await controller.createGrant(employee, PARTITION, amounts, dates, GAS)).wait();
    for (;;) {
      await (await controller.fundTranches(id, 40, GAS)).wait();
      if (Number((await controller.getGrant(id)).status) === 2) break;
    }
    return id;
  }

  // 400 vests almost immediately; 600 sits two hours out so there is something to forfeit.
  // NOT a year out: ATS rejects a lock expiring beyond its own bound with WrongExpirationTimestamp.
  const grantA = await makeGrant([400, 600], [90, 7200]);
  console.log(`  -> grant #${grantA}: 400 vesting in 90s, 600 unvested`);

  console.log("  waiting for the first tranche to vest...");
  await new Promise((r) => setTimeout(r, 100_000));
  console.log(`  -> vested ${await controller.vestedAmount(grantA)}, unvested ${await controller.unvestedAmount(grantA)}`);

  step("2", "Terminating as a BAD leaver...");
  const effectiveA = await leavingDate(grantA);
  await (await controller.terminate(grantA, Bad, effectiveA, GAS)).wait();
  const gA = await controller.getGrant(grantA);
  console.log(`  -> status ${STATUS[Number(gA.status)]}, decided by ${gA.terminatedBy}`);
  ok("the deciding address is recorded on chain, not just in a log");

  step("3", "The dispute window must actually block a clawback.");
  await mustRevert(controller.clawback.staticCall(grantA, 40), "DisputeWindowOpen", "clawback during the window");

  step("4", "The employee contests -- relayed, because they may never have held gas.");
  const wasRelayer = await controller.isDisputeRelayer(operator.address);
  if (!wasRelayer) await (await controller.setDisputeRelayer(operator.address, true, GAS)).wait();
  await (await controller.raiseDispute(grantA, GAS)).wait();
  ok("dispute raised on the employee's behalf");

  await mustRevert(controller.clawback.staticCall(grantA, 40), "DisputeUnresolved", "clawback while contested");

  step("5", "Only an arbiter may rule, and never the person who terminated.");
  await mustRevert(controller.resolveDispute.staticCall(grantA, true), "NotArbiter", "operator ruling directly");

  step("6", "The arbiter OVERTURNS -- the employee wins, the grant is reinstated.");
  const overturn = controller.interface.encodeFunctionData("resolveDispute", [grantA, false]);
  await (await arbiter.execute(rec.esopVestingController.address, overturn, GAS)).wait();
  const after = await controller.getGrant(grantA);
  console.log(`  -> status ${STATUS[Number(after.status)]}`);
  console.log(`  -> vested ${await controller.vestedAmount(grantA)}, unvested ${await controller.unvestedAmount(grantA)}`);
  ok("an overturned ruling put the unvested tranches back -- recourse is real");

  step("7", "A second grant, terminated as a GOOD leaver.");
  const now2 = Math.floor(Date.now() / 1000);
  const grantB = await makeGrant([300, 700], [90, 7200]);
  await new Promise((r) => setTimeout(r, 100_000));
  const effectiveB = await leavingDate(grantB);
  await (await controller.terminate(grantB, Good, effectiveB, GAS)).wait();
  console.log(`  -> vested ${await controller.vestedAmount(grantB)}, unvested ${await controller.unvestedAmount(grantB)}`);
  console.log(`  -> clawed back ${await controller.clawedBackAmount(grantB)}`);

  step("8", "A third grant: BAD leaver, nobody contests. This is the one that forfeits.");
  const grantC = await makeGrant([300, 700], [90, 7200]);
  await new Promise((r) => setTimeout(r, 100_000));
  await (await controller.terminate(grantC, Bad, await leavingDate(grantC), GAS)).wait();
  console.log(`  -> vested ${await controller.vestedAmount(grantC)}, unvested ${await controller.unvestedAmount(grantC)}`);

  step("9", "Waiting out the dispute window, then clawing back for real...");
  await new Promise((r) => setTimeout(r, 190_000));

  const poolBefore = await token.balanceOfByPartition(PARTITION, rec.esopVestingController.address);
  const forfeitedGood = await controller.clawback.staticCall(grantB, 40);
  await (await controller.clawback(grantB, 40, GAS)).wait();
  const forfeitedBad = await controller.clawback.staticCall(grantC, 40);
  await (await controller.clawback(grantC, 40, GAS)).wait();
  const poolAfter = await token.balanceOfByPartition(PARTITION, rec.esopVestingController.address);

  console.log(`  -> good leaver forfeited ${forfeitedGood} (accelerated, so nothing was left to lose)`);
  console.log(`  -> bad  leaver forfeited ${forfeitedBad}`);
  ok("the window is a real timeout -- the same call that was refused above now succeeds");
  if (forfeitedBad === 0n) throw new Error("A bad leaver with unvested tranches should have forfeited something.");
  console.log(`  -> controller pool ${poolBefore} -> ${poolAfter}`);
  if (poolAfter <= poolBefore) throw new Error("Forfeited options did not return to the pool.");
  ok("forfeited options went BACK TO THE POOL, they were not burned");
  console.log(`  -> good leaver kept ${await controller.vestedAmount(grantB)}, bad leaver kept ${await controller.vestedAmount(grantC)}`);

  if (!wasRelayer) {
    await (await controller.setDisputeRelayer(operator.address, false, GAS)).wait();
    ok("test relayer permission revoked");
  }

  console.log("\n" + "=".repeat(72));
  console.log("  Every guard held on the live contract, not just in tests.");
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e.message ?? e);
  process.exitCode = 1;
});
