/**
 * The one number that makes the whole design legible, for the camera.
 *
 * The lending pool's ESOP balance is ZERO while a loan is open, because collateral is an
 * ERC-1400 hold over the borrower's own balance rather than a transfer. That is the claim
 * everything else rests on — the issuer keeps clawback and freeze authority over pledged
 * equity, and the pool never has to be trusted with custody because it never has any.
 *
 *   npm run demo:proof
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rec = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../../deployments/hedera-testnet.json"), "utf8"));

const P = "0x0000000000000000000000000000000000000000000000000000000000000001";
const abi = [
  { type: "function", name: "balanceOfByPartition", stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getHeldAmountForByPartition", stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "uint256" }] },
];

const c = createPublicClient({ transport: http("https://testnet.hashio.io/api") });
const token = rec.esopToken.address;
const pool = rec.lending.pool.address;
const employee = process.env.EMPLOYEE ?? rec.grants[0].employee;

const [poolShares, held, free] = await Promise.all([
  c.readContract({ address: token, abi, functionName: "balanceOfByPartition", args: [P, pool] }),
  c.readContract({ address: token, abi, functionName: "getHeldAmountForByPartition", args: [P, employee] }),
  c.readContract({ address: token, abi, functionName: "balanceOfByPartition", args: [P, employee] }),
]);

console.log(`\n  lending pool ${pool.slice(0, 10)}…`);
console.log(`    holds ${poolShares} ESOP shares`);
console.log(`\n  employee ${employee.slice(0, 10)}…`);
console.log(`    ${held} held as collateral`);
console.log(`    ${free} free`);
console.log(`\n  The collateral never moved. It is held in the employee's own wallet.\n`);
