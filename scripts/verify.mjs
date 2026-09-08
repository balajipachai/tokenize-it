#!/usr/bin/env node
//
// Verifies a deployed contract on Sourcify, which is what HashScan and the
// Hedera mirror-node explorers read their verification status from.
// https://docs.hedera.com/evm/development/verifying
//
//   node scripts/verify.mjs                      # verifies the token in deployments/
//   node scripts/verify.mjs 0xabc...             # verifies a specific address
//   node scripts/verify.mjs 0xabc... --contract contracts/foo/Bar.sol:Bar
//   node scripts/verify.mjs 0xabc... --chain 295 # mainnet
//
// Note on what gets verified: our ESOP token is a ResolverProxy (an EIP-2535
// diamond) deployed BY the ATS factory, not by us. We still hold its compiler
// input, because we build the same pinned ATS source, so Sourcify can match it.
// The facets behind the diamond are separate contracts deployed by the ATS team.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = path.join(ROOT, "vendor/ats/packages/ats/contracts/artifacts");
const SOURCIFY = "https://sourcify.dev/server";

const DEFAULT_CONTRACT = "contracts/infrastructure/proxy/ResolverProxy.sol:ResolverProxy";
const HASHSCAN = { 295: "https://hashscan.io/mainnet", 296: "https://hashscan.io/testnet" };

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

function loadDeployments(chainId) {
  const file = path.join(ROOT, "deployments", `${chainId === 295 ? "hedera-mainnet" : "hedera-testnet"}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Finds the hardhat build-info whose compilation produced `contractIdentifier`. */
function findBuildInfo(contractIdentifier) {
  const [sourcePath, contractName] = contractIdentifier.split(":");
  const dbg = path.join(ARTIFACTS, sourcePath, `${contractName}.dbg.json`);
  if (!fs.existsSync(dbg)) {
    throw new Error(
      `No artifact for ${contractIdentifier}.\n` +
        `Looked for ${dbg}.\n` +
        `Run 'npm run setup:ats' and compile once (npm run test:lifecycle) first.`,
    );
  }
  const buildInfoPath = path.resolve(path.dirname(dbg), JSON.parse(fs.readFileSync(dbg, "utf8")).buildInfo);
  // These files are large (~90MB) because they carry the full AST; we only want
  // the compiler input and version, so drop the rest as soon as it is parsed.
  const raw = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  return { stdJsonInput: raw.input, compilerVersion: raw.solcLongVersion };
}

async function checkVerified(chainId, address) {
  const res = await fetch(`${SOURCIFY}/v2/contract/${chainId}/${address}`);
  if (!res.ok) return null;
  const body = await res.json();
  return body.match ?? body.runtimeMatch ?? body.creationMatch ?? null;
}

async function pollJob(verificationId) {
  // Compiling 576 sources server-side is not instant; give it a few minutes.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${SOURCIFY}/v2/verify/${verificationId}`);
    const body = await res.json();
    if (body.isJobCompleted) return body;
    process.stdout.write(`\r  compiling on Sourcify... ${(i + 1) * 5}s`);
  }
  throw new Error("Timed out waiting for Sourcify (the job may still finish; re-run to check).");
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const chainId = Number(flags.chain ?? 296);
  const contractIdentifier = flags.contract ?? DEFAULT_CONTRACT;

  const deployments = loadDeployments(chainId);
  const address = positional[0] ?? deployments?.esopToken?.address;
  const creationTransactionHash = flags.tx ?? deployments?.esopToken?.creationTxHash;

  if (!address) {
    console.error(
      "No address given and none recorded in deployments/.\n" +
        "Pass one explicitly:  node scripts/verify.mjs 0x...\n" +
        "Or run 'npm run testnet:lifecycle' first, which records what it deploys.",
    );
    process.exit(1);
  }

  console.log(`Verifying ${address}`);
  console.log(`  chain    ${chainId} (${chainId === 296 ? "Hedera testnet" : chainId === 295 ? "Hedera mainnet" : "?"})`);
  console.log(`  contract ${contractIdentifier}`);

  const already = await checkVerified(chainId, address);
  if (already) {
    console.log(`\nAlready verified on Sourcify (${already}).`);
    console.log(`  ${HASHSCAN[chainId]}/contract/${address}`);
    return;
  }

  console.log("\n  reading compiler input from the pinned ATS build...");
  const { stdJsonInput, compilerVersion } = findBuildInfo(contractIdentifier);
  const sizeMb = (JSON.stringify(stdJsonInput).length / 1024 / 1024).toFixed(1);
  console.log(`  solc ${compilerVersion}, ${Object.keys(stdJsonInput.sources).length} sources, ${sizeMb} MB payload`);

  const payload = { stdJsonInput, compilerVersion, contractIdentifier };
  if (creationTransactionHash) payload.creationTransactionHash = creationTransactionHash;

  const res = await fetch(`${SOURCIFY}/v2/verify/${chainId}/${address}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();

  if (res.status !== 202) {
    console.error(`\nSourcify rejected the submission (HTTP ${res.status}):`);
    console.error(`  ${body.customCode ?? "?"}: ${body.message ?? JSON.stringify(body)}`);
    // A already-verified race is a success, not a failure.
    if (body.customCode === "already_verified") {
      console.log(`\n  ${HASHSCAN[chainId]}/contract/${address}`);
      return;
    }
    process.exit(1);
  }

  console.log(`  submitted, job ${body.verificationId}`);
  const job = await pollJob(body.verificationId);
  process.stdout.write("\r".padEnd(50) + "\r");

  if (job.error || job.errorId) {
    console.error(`\nVerification failed: ${job.error?.customCode ?? ""} ${job.error?.message ?? JSON.stringify(job)}`);
    process.exit(1);
  }

  const match = job.contract?.match ?? job.contract?.runtimeMatch ?? "unknown";
  console.log(`\nVerified (${match}).`);
  console.log(`  ${HASHSCAN[chainId]}/contract/${address}`);
  console.log(`  ${SOURCIFY}/v2/contract/${chainId}/${address}`);
}

main().catch((e) => {
  console.error("\nFAILED", e.message ?? e);
  process.exit(1);
});
