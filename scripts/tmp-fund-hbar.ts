import { ethers } from "hardhat";
async function main() {
  const [op] = await ethers.getSigners();
  const to = process.env.TO!;
  const amount = ethers.parseEther(process.env.HBAR ?? "30");
  console.log(`funding ${to} with ${ethers.formatEther(amount)} HBAR`);
  // Generous: the first transfer to an unused Hedera address CREATES a hollow account
  // (HIP-32/542), which costs far more than a plain value transfer. 200k ran out.
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice!;
  const tx = await op.sendTransaction({ to, value: amount, gasLimit: 2_000_000n, gasPrice: (gasPrice * 120n) / 100n });
  const r = await tx.wait();
  console.log("  -> gas used", r!.gasUsed.toString(), "of 2,000,000");
  console.log("  -> balance now", ethers.formatEther(await ethers.provider.getBalance(to)), "HBAR");
}
main().catch((e) => { console.error(String(e.message ?? e).slice(0, 200)); process.exitCode = 1; });
