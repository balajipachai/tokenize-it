# Testing Phase 3 — the employee portal

> **Superseded as a checklist by [TESTING.md](./TESTING.md)**, which covers every phase in
> order. This page is kept for what it goes deeper on: Privy first-login behaviour, what an
> embedded wallet actually is, and the KYC question below — none of which the shorter pass
> repeats.

Reproduces the end-to-end run: sign in, receive a grant, watch it vest, claim it, and confirm the
result on-chain independently of the UI. About 5 minutes, most of it waiting for the cliff.

This doubles as the demo script for steps 3–4 of the pitch (§11 of `IMPLEMENTATION_PLAN.md`).

## 0. Prerequisites

| | |
|---|---|
| `.env` (repo root) | `HEDERA_TESTNET_PRIVATE_KEY_0` — the issuer/operator key |
| `apps/web/.env.local` | `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `RELAYER_PRIVATE_KEY` |
| Both accounts funded | testnet HBAR from the [portal faucet](https://portal.hedera.com) |
| ATS vendored | `npm run setup:ats` (once) |

The relayer should be a **different key from the issuer admin**. It pays every fee the portal
incurs; keeping it separate means a leaked relayer key cannot also administer the token.

Check the relayer has a balance before starting — an unfunded relayer fails at the Claim step,
which is the worst place to discover it.

## 1. Contracts still pass

```bash
npm run test:ats
```

Expect **71 passing** in ~20 seconds. This is the safety net; if it is red, stop here.

## 2. Start the portal

```bash
npm run dev                 # http://localhost:3000
```

If you see **"Almost there"**, `.env.local` is not being read — the Privy app ID is missing.

## 3. Sign in

Open http://localhost:3000 in a **fresh incognito window** (a persisted session skips the login
screen, which is exactly what you want to exercise on a first run).

- Expect the login screen: *"Sign in with your work email…"*.
- Sign in with an email. Privy creates an embedded wallet automatically — no wallet prompt, no seed
  phrase, no extension.
- Expect **"No grant yet"** with a `0x…` address. That address *is* the test: it came from Privy's
  directory server-side, not from the browser.

Copy that address.

## 4. Grant options to it

```bash
EMPLOYEE=0xYourPrivyWallet DEMO_CLIFF_SECONDS=75 DEMO_TRANCHE_SECONDS=600 npm run testnet:grant
```

Expect KYC + allowlisting, then `grant #N: 2400 options across 13 tranches`. The compressed cadence
is what makes a cliff land inside a demo; leave the env vars off for the realistic 4-year schedule.

## 5. Watch it vest

Reload the portal.

- **Vested and yours** reads `0` of `2,400`.
- **Next vest** counts down live, second by second.
- The timeline lists 13 tranches — the cliff marked, the next one highlighted blue.
- Rows show *times* rather than dates, because the schedule spans under two days.

Wait for the countdown to reach zero. Within ~15s (the poll interval) the cliff dot turns green,
the row reads **ready to claim**, and a **Claim 1 vested tranche** button appears.

## 6. Claim

Click **Claim**.

- Green banner: *"Claimed. Your vested options are now yours…"*
- **In your wallet** goes `0` → `1,200`.
- The cliff row loses "ready to claim"; the button disappears.

The employee signed nothing and paid nothing. The relayer submitted `releaseVested` and paid the
fee.

## 7. Confirm on-chain — a green UI is not evidence

```bash
node -e '
const {createPublicClient,http,formatEther}=require("viem");
const EMPLOYEE="0xYourPrivyWallet";
const c=createPublicClient({chain:{id:296,name:"h",nativeCurrency:{name:"HBAR",symbol:"HBAR",decimals:18},
  rpcUrls:{default:{http:["https://testnet.hashio.io/api"]}}},transport:http()});
const abi=[{type:"function",name:"balanceOfByPartition",stateMutability:"view",
  inputs:[{name:"p",type:"bytes32"},{name:"h",type:"address"}],outputs:[{type:"uint256"}]}];
const P="0x"+"0".repeat(63)+"1";
(async()=>{
  console.log("spendable:",Number(await c.readContract({address:"0x17E651D659704A47932ff7Ffd6032860E468cE58",
    abi,functionName:"balanceOfByPartition",args:[P,EMPLOYEE]})));
  console.log("native   :",formatEther(await c.getBalance({address:EMPLOYEE})));
})();'
```

Run from `apps/web/` so `viem` resolves.

**The assertion that matters is the second line: `native: 0`.** The employee holds real equity on an
unactivated Hedera account, having never held HBAR. If that is non-zero, the gasless claim is not
actually being demonstrated.

## 8. What you should have seen

- **During the claim:** a spinner, *"Claiming…"*, and the transaction hash as a HashScan link as
  soon as it is submitted — not after it confirms. The link is live while the transaction is still
  being mined, so you can follow it.
- **After:** a green banner with *View transaction*, the wallet stat increasing, and a permanent
  link on every claimed row of the schedule.
- **Compliance card:** KYC verified with an expiry, allowlist membership, the credential id, and the
  attesting issuer linked to HashScan.

## What this run does *not* cover

Worth knowing before treating a green run as full coverage:

- **The sign-out spinner** is implemented but has not been caught on camera — the state lasts
  milliseconds and confirming it costs you the session.
- **The `wallet_pending` path.** A brand-new account polls every 2s behind *"Setting up your
  wallet"* instead of flashing an error. Reproducing it needs a Privy account that has never had a
  wallet, so it has been verified by code path rather than observed.
- **Claim under contention** — two tabs clicking Claim at once. `releaseVested` is idempotent
  on-chain, so the second should no-op rather than double-spend, but that is reasoned, not observed.
- **Relayer failure paths** — an unfunded or rate-limited relayer surfaces as a 502 and the generic
  *"The claim did not go through"*. The error copy has not been checked against a real failure.
- **Terminated grants in the UI.** `status === 3` renders "grant terminated" and suppresses the
  countdown, but no run has driven a leaver through the portal.

## On KYC, because a judge will ask

*"You just call `grantKyc` yourself — what is actually being verified?"*

Three things are genuinely enforced, and the portal now shows all of them:

1. **The gate is on-chain.** A transfer to an address that fails KYC or the allowlist reverts.
   Covered by `tests/esopLifecycle.test.ts` 1.2, and by spike #1 for the liquidation path.
2. **Issuers are registered.** `grantKyc` reverts unless the attesting issuer was added via
   `ssiManagement.addIssuer`, so credentials cannot be minted by an arbitrary key.
3. **Revocation is retroactive.** `KycStorageWrapper` re-checks `isIssuer` on every *read*, so
   removing an issuer invalidates every credential it ever signed, immediately.

What is stubbed is the off-chain provider that verifies the human. Swapping it in changes who holds
`ROLE_KYC` and what `vcId` points at — **not the contract**. That is the honest answer, and it is a
stronger one than claiming full KYC.
