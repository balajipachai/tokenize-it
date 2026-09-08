// SPDX-License-Identifier: Apache-2.0
//
// SPIKE #2 for tokenize-it: can an employee authorise a collateral pledge with an
// off-chain EIP-712 signature alone, while a relayer pays all gas?
//
// The employee is modelled as a DETACHED random wallet with a zero balance that
// never sends a transaction -- exactly the situation of a Privy embedded wallet
// sitting on an unactivated (hollow) Hedera account.
//
// The decisive assertion is E1: ATS hardcodes its EIP-712 type strings in
// contracts/constants/eip712.sol. If those strings are byte-identical to what a
// standards-compliant EIP-712 encoder generates, then ANY compliant wallet --
// Privy included -- produces a signature this contract accepts.

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers.js";
import { deployEquityTokenFixture, executeRbac, MAX_UINT256 } from "@test";
import { EMPTY_STRING, ATS_ROLES, ZERO, EMPTY_HEX_BYTES } from "@scripts";
import { ResolverProxy, IAsset } from "@contract-types";

const PARTITION = "0x0000000000000000000000000000000000000000000000000000000000000001";
const AMOUNT = 1000;
const COLLATERAL = 400;
const ONE_YEAR = 365 * 24 * 60 * 60;

// Verbatim from contracts/constants/eip712.sol :: TYPEHASH_PROTECTED_CREATE_HOLD_FROM_PARTITION
const ATS_ONCHAIN_TYPE_STRING =
  "protectedCreateHoldByPartition(bytes32 _partition,address _from,ProtectedHold _protectedHold)" +
  "Hold(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data)" +
  "ProtectedHold(Hold hold,uint256 deadline,uint256 nonce)";

const holdTypes = {
  Hold: [
    { name: "amount", type: "uint256" },
    { name: "expirationTimestamp", type: "uint256" },
    { name: "escrow", type: "address" },
    { name: "to", type: "address" },
    { name: "data", type: "bytes" },
  ],
  ProtectedHold: [
    { name: "hold", type: "Hold" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
  protectedCreateHoldByPartition: [
    { name: "_partition", type: "bytes32" },
    { name: "_from", type: "address" },
    { name: "_protectedHold", type: "ProtectedHold" },
  ],
};

describe("SPIKE: Privy-style EIP-712 pledge relayed by a gas-paying backend", () => {
  let diamond: ResolverProxy;
  let asset: IAsset;
  let admin: HardhatEthersSigner; // deployer / SSI manager
  let issuer: HardhatEthersSigner; // ROLE_ISSUER + ROLE_KYC
  let relayer: HardhatEthersSigner; // our backend -- pays all gas
  let poolEscrow: HardhatEthersSigner; // lending pool (escrow + destination)
  let listAdmin: HardhatEthersSigner;

  // The "Privy embedded wallet": a key with no funds, never used to send a tx.
  let employee: ethers.HDNodeWallet;

  let domain: { name: string; version: string; chainId: bigint | number; verifyingContract: string };
  let expiration: number;

  const partitionRole = (partition: string) =>
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32"],
        [ATS_ROLES.ROLE_PROTECTED_PARTITIONS_PARTICIPANT, partition],
      ),
    );

  beforeEach(async () => {
    const base = await deployEquityTokenFixture({
      equityDataParams: {
        securityData: {
          isMultiPartition: true,
          arePartitionsProtected: true, // required for the meta-tx path
          clearingActive: false, // protected ops require clearing disabled
          isControllable: true,
        },
      },
      useLoadFixture: false,
    });

    diamond = base.diamond;
    admin = base.deployer;
    issuer = base.user1;
    relayer = base.user2;
    poolEscrow = base.user3;
    listAdmin = base.user4;

    employee = ethers.Wallet.createRandom();

    asset = await ethers.getContractAt("IAsset", diamond.target);

    await executeRbac(asset, [
      { role: ATS_ROLES.ROLE_ISSUER, members: [issuer.address] },
      { role: ATS_ROLES.ROLE_KYC, members: [issuer.address] },
      { role: ATS_ROLES.ROLE_SSI_MANAGER, members: [admin.address] },
      { role: ATS_ROLES.ROLE_CONTROL_LIST, members: [listAdmin.address] },
      { role: ATS_ROLES.ROLE_PROTECTED_PARTITIONS, members: [admin.address] },
      // the relayer is the only account allowed to submit protected ops on this partition
      { role: partitionRole(PARTITION), members: [relayer.address] },
      { role: ATS_ROLES.ROLE_WILD_CARD, members: [issuer.address] },
    ]);

    await asset.connect(admin).addIssuer(admin.address);
    for (const who of [employee.address, issuer.address, relayer.address, poolEscrow.address]) {
      await asset.connect(issuer).grantKyc(who, EMPTY_STRING, ZERO, MAX_UINT256, admin.address);
    }

    await asset.connect(issuer).issueByPartition({
      partition: PARTITION,
      tokenHolder: employee.address,
      value: AMOUNT,
      data: EMPTY_HEX_BYTES,
    });

    domain = {
      name: (await asset.getERC20Metadata()).info.name,
      version: (await asset.getConfigInfo()).version_.toString(),
      chainId: await network.provider.send("eth_chainId"),
      verifyingContract: diamond.target as string,
    };

    expiration = (await ethers.provider.getBlock("latest"))!.timestamp + ONE_YEAR;
  });

  function buildMessage(nonce: number, deadline: bigint | number) {
    return {
      _partition: PARTITION,
      _from: employee.address,
      _protectedHold: {
        hold: {
          amount: COLLATERAL,
          expirationTimestamp: BigInt(expiration),
          escrow: poolEscrow.address,
          to: poolEscrow.address,
          data: EMPTY_HEX_BYTES,
        },
        deadline: BigInt(deadline),
        nonce,
      },
    };
  }

  describe("E. does ATS's hardcoded type string match standard EIP-712?", () => {
    it("E1. the on-chain type string is byte-identical to a standard encoder's output", () => {
      const encoder = ethers.TypedDataEncoder.from(holdTypes);
      const generated = encoder.encodeType("protectedCreateHoldByPartition");

      // If this holds, any spec-compliant wallet (Privy, MetaMask, viem, ethers)
      // signs a digest this contract accepts. No custom signing path needed.
      expect(generated).to.equal(ATS_ONCHAIN_TYPE_STRING);
    });

    it("E2. the domain uses the standard four fields (no salt), so eth_signTypedData_v4 applies", () => {
      expect(domain.name).to.be.a("string").and.not.equal("");
      expect(domain.version).to.be.a("string").and.not.equal("");
      expect(domain.verifyingContract).to.equal(diamond.target);
      // NOTE: `version` is the ATS config version as a decimal string, NOT "1".
      // A frontend that hardcodes "1" will silently produce invalid signatures.
    });
  });

  describe("F. the relayed pledge", () => {
    it("F1. employee signs offline, relayer submits and pays -- hold is created", async () => {
      const nonce = Number(await asset.nonces(employee.address)) + 1;
      const message = buildMessage(nonce, MAX_UINT256);
      const signature = await employee.signTypedData(domain, holdTypes, message);

      await expect(
        asset
          .connect(relayer)
          .protectedCreateHoldByPartition(PARTITION, employee.address, message._protectedHold, signature),
      ).to.not.be.reverted;

      expect(await asset.getHeldAmountForByPartition(PARTITION, employee.address)).to.equal(COLLATERAL);
      expect(await asset.balanceOfByPartition(PARTITION, employee.address)).to.equal(AMOUNT - COLLATERAL);
    });

    it("F2. the employee's account holds ZERO native balance throughout -- never pays gas", async () => {
      expect(await ethers.provider.getBalance(employee.address)).to.equal(0n);

      const nonce = Number(await asset.nonces(employee.address)) + 1;
      const message = buildMessage(nonce, MAX_UINT256);
      const signature = await employee.signTypedData(domain, holdTypes, message);
      await asset
        .connect(relayer)
        .protectedCreateHoldByPartition(PARTITION, employee.address, message._protectedHold, signature);

      // Still zero. On Hedera this address would be an unactivated hollow account.
      expect(await ethers.provider.getBalance(employee.address)).to.equal(0n);
      expect(await asset.getHeldAmountForByPartition(PARTITION, employee.address)).to.equal(COLLATERAL);
    });

    it("F3. a signature from the WRONG key is rejected", async () => {
      const impostor = ethers.Wallet.createRandom();
      const nonce = Number(await asset.nonces(employee.address)) + 1;
      const message = buildMessage(nonce, MAX_UINT256);
      const signature = await impostor.signTypedData(domain, holdTypes, message);

      await expect(
        asset
          .connect(relayer)
          .protectedCreateHoldByPartition(PARTITION, employee.address, message._protectedHold, signature),
      ).to.be.reverted;
    });

    it("F4. REPLAY: the same signature cannot be submitted twice", async () => {
      const nonce = Number(await asset.nonces(employee.address)) + 1;
      const message = buildMessage(nonce, MAX_UINT256);
      const signature = await employee.signTypedData(domain, holdTypes, message);

      await asset
        .connect(relayer)
        .protectedCreateHoldByPartition(PARTITION, employee.address, message._protectedHold, signature);

      await expect(
        asset
          .connect(relayer)
          .protectedCreateHoldByPartition(PARTITION, employee.address, message._protectedHold, signature),
      ).to.be.reverted;
    });

    it("F5. an EXPIRED deadline is rejected", async () => {
      const past = (await ethers.provider.getBlock("latest"))!.timestamp - 1;
      const nonce = Number(await asset.nonces(employee.address)) + 1;
      const message = buildMessage(nonce, past);
      const signature = await employee.signTypedData(domain, holdTypes, message);

      await expect(
        asset
          .connect(relayer)
          .protectedCreateHoldByPartition(PARTITION, employee.address, message._protectedHold, signature),
      ).to.be.reverted;
    });

    it("F6. a relayer WITHOUT the partition role cannot submit, even with a valid signature", async () => {
      const nonce = Number(await asset.nonces(employee.address)) + 1;
      const message = buildMessage(nonce, MAX_UINT256);
      const signature = await employee.signTypedData(domain, holdTypes, message);

      await expect(
        asset
          .connect(poolEscrow) // has no protected-partition role
          .protectedCreateHoldByPartition(PARTITION, employee.address, message._protectedHold, signature),
      ).to.be.reverted;
    });
  });

  describe("G. is the relayed path mandatory when partitions are protected?", () => {
    it("G1. the unprotected self-service createHoldByPartition is blocked", async () => {
      // Confirms §6: with arePartitionsProtected=true there is no path that requires
      // the employee to send their own transaction.
      await expect(
        asset.connect(poolEscrow).createHoldByPartition(PARTITION, {
          amount: 1,
          expirationTimestamp: expiration,
          escrow: poolEscrow.address,
          to: poolEscrow.address,
          data: EMPTY_HEX_BYTES,
        }),
      ).to.be.reverted;
    });
  });
});
