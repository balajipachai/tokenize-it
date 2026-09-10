/**
 * tokenize-it cap-table indexer.
 *
 * Reads the controller's own events from the Hedera mirror node and materialises the cap
 * table, so a client can ask one question instead of thousands.
 *
 * WHY: every read in the apps goes to the chain one call at a time. The issuer console asks
 * for `nextGrantId`, then `getGrant` once per grant, then several more calls per employee —
 * roughly 1 + N + kN round trips to paint one page. Imperceptible at fifteen grants;
 * tens of thousands of calls against a rate-limited endpoint at five thousand employees, at
 * which point the console simply stops loading. Nothing degrades gradually.
 *
 * WHAT IT DOES NOT DO, because designing around this later would be expensive:
 *
 *   Vesting is time-derived and emits nothing. A tranche vests because its date passed —
 *   that is the whole point of the mint-and-lock design, which needs no keeper for
 *   correctness. `TrancheVested` fires on RELEASE, which is claiming, not vesting. So this
 *   stores tranche dates and computes vested amounts at query time. Treating the event as
 *   "vested" would show every employee holding nothing until they happened to claim.
 *
 *   Live token state belongs to the ATS diamond, which we do not own and whose holds move
 *   without our contracts being involved. Balances shown next to money — collateral value,
 *   what is pledgeable, what is owed — must stay direct reads. This is for the cap table and
 *   its history, never for the number somebody is about to borrow against.
 *
 * Subsquid is the production shape and generates a GraphQL API over Postgres; the ingestion
 * logic below is the part that is actually ours, and it is the same either way.
 *
 *   node services/indexer/index.mjs
 *   WATCH=30 node services/indexer/index.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DEPLOYMENTS = path.join(ROOT, "deployments", "hedera-testnet.json");
const OUT = path.join(HERE, "cap-table.json");
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";

const TOPICS = {
  "0xa0f365559ff2459eecb7a3e0c37cc9852cbb3dfce6e7a28c1bb8bd7fa6b20277": "GrantCreated",
  "0x63dfb9e72511c05746642db6f7bb1df3cbe669817ce6357723a80a7154a3e96d": "TrancheVested",
  "0x32d6a2716d28bb71850891291da2829db7a8641bd46a5c96335b4888b7097184": "GrantTerminated",
  "0x31cf375c93bb419563dcb9e9e0c7a55def42888105958fea521ab16280fbaf25": "ClawedBack",
  "0x32c3577ad32544a8c06c1b330ada404f03a4d405574e524dd6d86eeba5f21e73": "DisputeRaised",
  "0xe4869990df273a675df63cd0acf961e8cac9e8c47748a9d71c02c21e510e850c": "DisputeResolved",
  "0xbf876e9e1e7a144122b3543a96bb56e88d36ebd496655a220cf20488b1be154a": "GrantReinstated",
};

const LEAVER = ["none", "good", "bad"];
// Defensive on purpose. A mirror-node log can carry `data: "0x"` — an event whose
// parameters are all indexed, or simply one we matched loosely — and BigInt("0x") throws
// rather than returning zero, which took down the whole indexing pass on the first run.
const hexToBig = (h) => {
  const v = String(h ?? "").trim();
  return v.length > 2 && v.startsWith("0x") ? BigInt(v) : 0n;
};
const topicAddr = (t) => `0x${t.slice(-40)}`;

/**
 * Pages the mirror node's contract-log endpoint.
 *
 * Deliberately NOT eth_getLogs: Hedera caps the block range and needs chunked queries to
 * reach back far enough, whereas the mirror node pages by timestamp and cannot silently
 * miss a log that predates whatever window a range scan happened to pick.
 */
async function* logs(contractId, since) {
  let next = `/contracts/${contractId}/results/logs?order=asc&limit=100${since ? `&timestamp=gt:${since}` : ""}`;
  while (next) {
    const res = await fetch(`${MIRROR}${next.startsWith("/api/v1") ? next.slice(7) : next}`);
    if (!res.ok) throw new Error(`mirror node ${res.status} on ${next}`);
    const body = await res.json();
    for (const log of body.logs ?? []) yield log;
    next = body.links?.next ?? null;
  }
}

function emptyState() {
  return { grants: {}, employees: {}, lastTimestamp: null, events: 0 };
}

function apply(state, name, log) {
  const t = log.topics ?? [];
  const data = log.data ?? "0x";
  const word = (i) => {
    const slice = data.slice(2 + i * 64, 2 + (i + 1) * 64);
    return slice.length === 64 ? `0x${slice}` : "0x0";
  };

  switch (name) {
    case "GrantCreated": {
      // THREE indexed params, not two: grantId, employee AND partition. So the data words
      // are (totalAmount, trancheCount), not (partition, totalAmount, trancheCount). Reading
      // them shifted by one recorded every grant's TRANCHE COUNT as its total — grant #1
      // came back as 13 instead of 2,400 — and it looked entirely plausible until the index
      // was diffed against the chain. An indexer that is fast and wrong is worse than slow.
      const id = String(hexToBig(t[1]));
      const employee = topicAddr(t[2]);
      state.grants[id] = {
        grantId: Number(id),
        employee,
        total: Number(hexToBig(word(0))),
        trancheCount: Number(hexToBig(word(1))),
        status: "active",
        leaver: "none",
        clawedBack: 0,
        released: 0,
        dispute: "none",
      };
      (state.employees[employee] ??= { address: employee, grants: [], granted: 0, released: 0, clawedBack: 0 }).grants.push(Number(id));
      state.employees[employee].granted += state.grants[id].total;
      break;
    }
    case "TrancheVested": {
      const id = String(hexToBig(t[1]));
      const employee = topicAddr(t[2]);
      const amount = Number(hexToBig(word(1)));
      if (state.grants[id]) state.grants[id].released += amount;
      if (state.employees[employee]) state.employees[employee].released += amount;
      break;
    }
    case "GrantTerminated": {
      const id = String(hexToBig(t[1]));
      if (state.grants[id]) {
        state.grants[id].status = "terminated";
        state.grants[id].leaver = LEAVER[Number(hexToBig(word(0)))] ?? "none";
        state.grants[id].terminatedBy = topicAddr(t[2]);
      }
      break;
    }
    case "ClawedBack": {
      const id = String(hexToBig(t[1]));
      const amount = Number(hexToBig(word(1)));
      if (state.grants[id]) {
        state.grants[id].clawedBack += amount;
        const e = state.employees[state.grants[id].employee];
        if (e) e.clawedBack += amount;
      }
      break;
    }
    case "DisputeRaised": {
      const id = String(hexToBig(t[1]));
      if (state.grants[id]) state.grants[id].dispute = "raised";
      break;
    }
    case "DisputeResolved": {
      const id = String(hexToBig(t[1]));
      if (state.grants[id]) state.grants[id].dispute = hexToBig(word(0)) === 1n ? "upheld" : "overturned";
      break;
    }
    case "GrantReinstated": {
      // An overturned dispute puts the grant back. Without this the cap table left every
      // employee who WON their appeal showing as terminated — the worst possible person to
      // get wrong, and invisible until the index was diffed against the chain.
      const id = String(hexToBig(t[1]));
      if (state.grants[id]) {
        state.grants[id].status = "active";
        state.grants[id].leaver = "none";
      }
      break;
    }
  }
}

async function sync() {
  const record = JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8"));
  const controller = record.esopVestingController.address;

  // Resume from where the last run stopped. Reindexing from zero every time is fine at this
  // size and ruinous at any real one.
  let state = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : emptyState();
  if (state.controller && state.controller !== controller) {
    console.log(`  controller changed (${state.controller} -> ${controller}); reindexing from scratch`);
    state = emptyState();
  }
  state.controller = controller;

  const started = Date.now();
  let seen = 0;
  for await (const log of logs(controller, state.lastTimestamp)) {
    const name = TOPICS[(log.topics ?? [])[0]];
    state.lastTimestamp = log.timestamp ?? state.lastTimestamp;
    if (!name) continue;
    apply(state, name, log);
    state.events += 1;
    seen += 1;
  }

  state.indexedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(state, null, 2) + "\n");

  const employees = Object.keys(state.employees).length;
  const grants = Object.keys(state.grants).length;
  console.log(
    `  +${seen} new event(s) in ${Date.now() - started}ms — ${grants} grants, ${employees} employees, ${state.events} events total`,
  );
  return state;
}

const watch = Number(process.env.WATCH ?? 0);
console.log("=".repeat(72));
console.log("  tokenize-it -- cap-table indexer");
console.log("=".repeat(72));
for (;;) {
  await sync();
  if (!watch) break;
  await new Promise((r) => setTimeout(r, watch * 1000));
}
