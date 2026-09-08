// SPDX-License-Identifier: Apache-2.0
//
// PHASE 1 (testnet leg) -- the ESOP lifecycle against real Hedera testnet.
//
// tests/esopLifecycle.test.ts already proves the CONTRACT behaviour on a local
// EVM. This script exists to answer the questions only Hedera can answer:
//
//   Q1  Does deployEquity through the pre-deployed testnet factory accept our
//       production flag set? (our contracts are pinned newer than the deployed BLR)
//   Q2  What does transferAndLockByPartition ACTUALLY cost on Hedera, versus the
//       425k we measured locally? This drives the tranche-batching rule.
//   Q3  Can a never-funded (hollow) address receive ESOP tokens?
//   Q4  Does an EIP-712 signature from an unfunded wallet validate on chainId 296,
//       with the relayer paying? (spike #2, but for real)
//   Q5  Does the clawback path work on Hedera?
//
// Vesting periods are compressed to seconds so release is observable in one run.
//
//   npm run testnet:lifecycle

import { ethers } from "hardhat";
import { ethers as ethersLib } from "ethers";
import { deployEquityFromFactory, ATS_ROLES, EQUITY_CONFIG_ID } from "@scripts";
import { IFactory__factory, IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const EMPTY_HEX = "0x";
const MAX_UINT256 = ethersLib.MaxUint256;

const POOL_SIZE = 1_000_000;
const TRANCHES = 13; // cliff + 12 -- enough to extrapolate to 37 without burning testnet HBAR
const CLIFF_AMOUNT = 1_200;
const TRANCHE_AMOUNT = 100;
const GRANT_TOTAL = CLIFF_AMOUNT + (TRANCHES - 1) * TRANCHE_AMOUNT;

const CLIFF_DELAY = 45; // seconds
const TRANCHE_SPACING = 3600; // later tranches stay unvested, so we can claw them back

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function step(n: string, msg: string) {
  console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
}

async function main() {
  const [operator] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(operator.address);

  console.log("=".repeat(72));
  console.log("  tokenize-it -- Phase 1 lifecycle on Hedera testnet");
  console.log("=".repeat(72));
  console.log(`  operator   ${operator.address}`);
  console.log(`  account id ${process.env.HEDERA_TESTNET_ACCOUNT_ID ?? "(unset)"}`);
  console.log(`  chainId    ${net.chainId}  (296 = Hedera testnet)`);
  console.log(`  balance    ${ethersLib.formatEther(balance)} HBAR-equivalent`);

  if (balance === 0n) throw new Error("Operator has no balance -- fund it from the Hedera portal faucet.");

  // "Priya" -- a fresh key that is NEVER funded and NEVER sends a transaction.
  // This is exactly a Privy embedded wallet on an unactivated Hedera account.
  const priya = ethersLib.Wallet.createRandom();
  console.log(`  employee   ${priya.address} (unfunded, hollow)`);

  // ---------------------------------------------------------------- Q1: deploy
  step("Q1", "Deploying ESOP equity through the pre-deployed testnet factory...");
  const factory = IFactory__factory.connect(env("ATS_FACTORY_ADDRESS"), operator);
  const resolver = env("ATS_RESOLVER_ADDRESS");

  const partitionRole = ethersLib.keccak256(
    ethersLib.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [ATS_ROLES.ROLE_PROTECTED_PARTITIONS_PARTICIPANT, PARTITION],
    ),
  );

  const diamond = await deployEquityFromFactory(
    {
      adminAccount: operator.address,
      factory,
      securityData: {
        resolver,
        resolverProxyConfiguration: { key: EQUITY_CONFIG_ID, version: Number(env("ATS_EQUITY_CONFIG_VERSION", "1")) },
        maxSupply: POOL_SIZE,
        erc20MetadataInfo: { name: "Acme ESOP 2026-A", symbol: "ESOP", decimals: 0, isin: "US0378331005" },
        // The production flag set from IMPLEMENTATION_PLAN.md §3.1
        isMultiPartition: true,
        isControllable: true,
        internalKycActivated: true,
        isWhiteList: true,
        arePartitionsProtected: true,
        clearingActive: false,
        erc20VotesActivated: false,
        externalPauses: [],
        externalControlLists: [],
        externalKycLists: [],
        compliance: ethersLib.ZeroAddress,
        identityRegistry: ethersLib.ZeroAddress,
        rbacs: [
          { role: ATS_ROLES.ROLE_ISSUER, members: [operator.address] },
          { role: ATS_ROLES.ROLE_LOCKER, members: [operator.address] },
          { role: ATS_ROLES.ROLE_CONTROLLER, members: [operator.address] },
          { role: ATS_ROLES.ROLE_KYC, members: [operator.address] },
          { role: ATS_ROLES.ROLE_CONTROL_LIST, members: [operator.address] },
          { role: ATS_ROLES.ROLE_FREEZE_MANAGER, members: [operator.address] },
          { role: ATS_ROLES.ROLE_SSI_MANAGER, members: [operator.address] },
          { role: ATS_ROLES.ROLE_WILD_CARD, members: [operator.address] },
          { role: ATS_ROLES.ROLE_PROTECTED_PARTITIONS, members: [operator.address] },
          { role: partitionRole, members: [operator.address] },
        ],
      } as never,
      equityDetails: {
        votingRight: true,
        informationRight: false,
        liquidationRight: true,
        subscriptionRight: false,
        conversionRight: false,
        redemptionRight: false,
        putRight: false,
        dividendRight: 1,
        currency: "0x555344", // USD
        nominalValue: 100,
        nominalValueDecimals: 2,
      } as never,
    },
    { regulationType: 1, regulationSubType: 0, countriesControlListType: true, listOfCountries: "", info: "" } as never,
  );

  const token = (await ethers.getContractAt("IAsset", diamond.target)) as unknown as IAsset;
  console.log(`  -> ESOP token deployed at ${diamond.target}`);
  console.log(`     add to .env as ESOP_TOKEN_ADDRESS=${diamond.target}`);

  // ------------------------------------------------------------- onboarding
  step("--", "Onboarding: KYC + allowlist for the treasury and the employee...");
  await (await token.addIssuer(operator.address)).wait();
  for (const who of [operator.address, priya.address]) {
    await (await token.grantKyc(who, "", 0, MAX_UINT256, operator.address)).wait();
    await (await token.addToControlList(who)).wait();
  }
  console.log("  -> both onboarded");

  step("--", `Minting the ${POOL_SIZE.toLocaleString()}-option pool to the treasury...`);
  await (
    await token.issueByPartition({
      partition: PARTITION,
      tokenHolder: operator.address,
      value: POOL_SIZE,
      data: EMPTY_HEX,
    })
  ).wait();
  console.log(`  -> totalSupply ${await token.totalSupply()}`);

  // ------------------------------------------------------------------ Q2 + Q3
  step("Q2/Q3", `Granting ${GRANT_TOTAL} options to the hollow employee as ${TRANCHES} locked tranches...`);
  const now = Math.floor(Date.now() / 1000);
  const schedule: { amount: number; vestsAt: number }[] = [{ amount: CLIFF_AMOUNT, vestsAt: now + CLIFF_DELAY }];
  for (let i = 1; i < TRANCHES; i++) {
    schedule.push({ amount: TRANCHE_AMOUNT, vestsAt: now + CLIFF_DELAY + i * TRANCHE_SPACING });
  }

  let totalGas = 0n;
  let maxGas = 0n;
  for (const [i, t] of schedule.entries()) {
    const rc = await (
      await token.transferAndLockByPartition(PARTITION, priya.address, t.amount, EMPTY_HEX, t.vestsAt)
    ).wait();
    totalGas += rc!.gasUsed;
    if (rc!.gasUsed > maxGas) maxGas = rc!.gasUsed;
    process.stdout.write(`\r  tranche ${i + 1}/${TRANCHES}  gas ${rc!.gasUsed}   `);
  }
  console.log(
    `\n  -> HEDERA GAS: ${totalGas} total, ${totalGas / BigInt(TRANCHES)} avg, ${maxGas} max single tranche`,
  );
  console.log(`     extrapolated to a 37-tranche grant: ~${(totalGas / BigInt(TRANCHES)) * 37n} total`);
  console.log(`  -> employee locked balance: ${await token.getLockedAmountForByPartition(PARTITION, priya.address)}`);
  console.log(`     (Q3 answered: a hollow, never-funded address CAN hold ESOPs)`);

  // ---------------------------------------------------------------- vesting
  step("--", `Waiting ${CLIFF_DELAY}s for the cliff to vest...`);
  await sleep((CLIFF_DELAY + 8) * 1000);

  step("--", "Releasing the cliff tranche (permissionless -- the operator is not the holder)...");
  await (await token.releaseByPartition(PARTITION, 1, priya.address)).wait();
  console.log(`  -> spendable: ${await token.balanceOfByPartition(PARTITION, priya.address)}`);
  console.log(`  -> still locked: ${await token.getLockedAmountForByPartition(PARTITION, priya.address)}`);

  // -------------------------------------------------------------------- Q4
  step("Q4", "Employee signs EIP-712 offline; relayer submits and pays the gas...");
  const domain = {
    name: (await token.getERC20Metadata()).info.name,
    version: (await token.getConfigInfo()).version_.toString(),
    chainId: net.chainId,
    verifyingContract: diamond.target as string,
  };
  console.log(`  domain: name="${domain.name}" version="${domain.version}" chainId=${domain.chainId}`);

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
  const nonce = (await token.nonces(priya.address)) + 1n;
  const signature = await priya.signTypedData(domain, types, {
    _partition: PARTITION,
    _from: priya.address,
    _to: operator.address,
    _amount: 50,
    _deadline: MAX_UINT256,
    _nonce: nonce,
  });

  const relayRc = await (
    await token.protectedTransferFromByPartition(PARTITION, priya.address, operator.address, 50, {
      deadline: MAX_UINT256,
      nonce,
      signature,
    })
  ).wait();
  console.log(`  -> relayed transfer succeeded, gas ${relayRc!.gasUsed}`);
  console.log(`  -> employee native balance: ${await ethers.provider.getBalance(priya.address)} (never paid gas)`);

  // -------------------------------------------------------------------- Q5
  step("Q5", "Leaver: force-release the unvested tranches and burn them...");
  const lockedBefore = await token.getLockedAmountForByPartition(PARTITION, priya.address);
  const lockIds = await token.getLocksIdForByPartition(PARTITION, priya.address, 0, 100);
  for (const id of lockIds) {
    await (await token.forceReleaseByPartition(PARTITION, id, priya.address)).wait();
  }
  await (
    await token.controllerRedeemByPartition(PARTITION, priya.address, lockedBefore, EMPTY_HEX, EMPTY_HEX)
  ).wait();
  console.log(`  -> clawed back and burned ${lockedBefore} unvested options`);
  console.log(`  -> employee retains ${await token.balanceOfByPartition(PARTITION, priya.address)} vested`);
  console.log(`  -> locked now: ${await token.getLockedAmountForByPartition(PARTITION, priya.address)}`);

  console.log("\n" + "=".repeat(72));
  console.log("  All five Hedera-specific questions answered. Token:", diamond.target);
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("\n\x1b[31mFAILED\x1b[0m", e);
  process.exitCode = 1;
});
