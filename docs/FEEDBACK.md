# Feedback from testing

Issues found while testing the app end to end, recorded to be taken up later. Each entry keeps
what was seen, what was checked, and the likely fix, so it can be picked up without starting over.

---

## 1. A newer grant hides an older one that still needs action

**Status:** open — deferred, to be taken up later
**Reported:** 2026-09-12, while testing the dispute flow
**Where:** issuer console (`/issuer`); the employee portal has the same flaw

### What happened

HR terminated grant **#7** for employee `0x8a3DbE90c97943D8dd1E7D95F6857684a99A16e9` as a bad
leaver and did not claw it back. HR then issued a new grant, **#8**, to the same employee. The
console now shows only grant #8 for that employee. Grant #7 has disappeared from view, and with
it the only **Clawback** button, so HR has no way to claw it back from the UI.

### What was checked (on-chain, 2026-09-12)

| Grant | Status | Dispute | Dispute window | Unvested | Clawed back |
|---|---|---|---|---|---|
| #7 | Terminated | upheld | closed | 900 | 0 |
| #8 | Active | none | — | 1,125 | 0 |

`grantsOf(0x8a3D…16e9)` returns `5, 6, 7, 8`.

Grant #7's dispute was **upheld**, so the contract allows clawback right now: an upheld ruling lets
it proceed immediately. **Only the UI is in the way**; the contract is fine.

### Cause

Both halves of the app show one grant per employee, the most recent:

- **Issuer console:** `readHolder` in `apps/web/lib/esop.ts` takes `grantIds[grantIds.length - 1]`,
  and the employee card renders that one grant's status, figures and buttons.
- **Employee portal:** `readPosition` in `apps/web/lib/contracts.ts` does the same.

This has not been hit on the portal side yet, but the consequence would be worse there. If a new
grant is issued while an older one is terminated with its dispute window still open, the
"Contest this termination" panel for the older grant vanishes. The employee would lose the
ability to appeal without anything telling them so.

### Likely fix

- **Issuer console:** show every grant that still needs action, not just the latest. At minimum:
  a terminated grant that has not been fully clawed back, and a grant with a dispute awaiting a
  ruling. A list of grants inside each employee's card, each with its own status and buttons,
  would do it.
- **Employee portal:** surface every terminated grant that has an open dispute window or a
  pending dispute, alongside the current one, so an appeal can never be hidden by a newer grant.
- Worth a test on both sides: issue a second grant while the first is terminated and unresolved,
  and check the first is still reachable.

### Until then

There is no way to do this from the UI. A grant admin can still call `clawback(7, maxCount)` on the
controller directly; there is no ready-made script for it yet.
