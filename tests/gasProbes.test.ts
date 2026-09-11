import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Does a manual `unchecked { ++i; }` still save gas on solc 0.8.28?
 *
 * The advice is older than the compiler. 0.8.22 began emitting the unchecked increment
 * itself when it can prove the counter cannot overflow, which is every well-formed `for`
 * loop over a length. Measure before rewriting sixteen loops for it.
 */
describe("GAS: is `unchecked { ++i; }` still worth writing by hand?", () => {
  it("measures a checked loop against a hand-unchecked one", async () => {
    const Probe = await ethers.getContractFactory("LoopProbe");
    const probe = await Probe.deploy();
    await probe.waitForDeployment();

    // Warm the sink first: an unwarmed storage slot swamps the difference being measured,
    // which is how an earlier benchmark in this repo reversed two of its own verdicts.
    await (await probe.checkedLoop(1)).wait();

    for (const n of [10, 50]) {
      const a = await probe.checkedLoop.estimateGas(n);
      const b = await probe.uncheckedLoop.estimateGas(n);
      const delta = Number(a) - Number(b);
      console.log(
        `        n=${String(n).padStart(3)}  compiler ${a}   hand-unchecked ${b}   ` +
          `${delta === 0 ? "identical" : `${delta > 0 ? "-" : "+"}${Math.abs(delta)} gas`}`,
      );
      // The claim under test: on 0.8.28 the compiler already does this.
      expect(Math.abs(delta)).to.be.lessThan(Number(a) / 100);
    }
  });
});

/**
 * What does the hand-rolled `nonReentrant` actually cost against OpenZeppelin's?
 *
 * Both are correct, so this is not a safety question — it is whether "we wrote our own"
 * was paying for itself. Measured rather than argued, because the answer depends on refund
 * caps and slot warmth, which reasoning gets wrong more often than not.
 */
describe("GAS: hand-rolled reentrancy guard vs OpenZeppelin's", () => {
  it("measures both guards around an identical body", async () => {
    const Hand = await ethers.getContractFactory("HandRolledGuardProbe");
    const Oz = await ethers.getContractFactory("OzGuardProbe");
    const hand = await Hand.deploy();
    const oz = await Oz.deploy();
    await hand.waitForDeployment();
    await oz.waitForDeployment();

    // Warm `sink` on both, so the number being compared is the guard and not a first write.
    await (await hand.work()).wait();
    await (await oz.work()).wait();

    const a = await hand.work.estimateGas();
    const b = await oz.work.estimateGas();
    console.log(`        hand-rolled ${a}   openzeppelin ${b}   delta ${Number(a) - Number(b)} gas`);

    // The claim under test: OZ's 1->2->1 beats our 0->1->0.
    expect(Number(b)).to.be.lessThan(Number(a));
  });
});
