# Pi Durable prototype — review summary

A small index for a reviewing agent. Everything below lives on the branch/links given here; nothing was pushed upstream.

## Where

- Fork: https://github.com/AndrewGoldfinch/firstmate
- Branch: `experiment/pi-durable-review-fixes` (local-only; review-fixes commit `05e81277`; not pushed)
- Prototype branch: `experiment/pi-durable-supervision` (head `77b49eb007be57ce4d117503f94626332ce32b8f`)
- Prototype full diff vs fork `main`: https://github.com/AndrewGoldfinch/firstmate/compare/main...experiment/pi-durable-supervision
- Base: `1f3e7696` (upstream `main` at P0 start; upstream is untouched)

## What this is

An opt-in **Pi Durable** execution provider for FirstMate's Pi supervision path, built as a personal experiment.
FirstMate keeps all authority (eligibility, leases, generations, outcomes, acknowledgements); the Pi Durable library (`@earendil-works/pi-durable`) owns execution records for conversations assigned to it.
The existing supervision path stays the default and is unchanged when the opt-in provider is off.

## Review fixes (this pass)

1. Current generation, claim, row scope, and cancellation state are re-enforced at the outcome mutation boundary (acceptance, settlement, receipt), serialized with ownership changes; a replacement refuses the stale settlement, append, and receipt.
2. The store-owner lock publishes fully written metadata with `link(2)` and reclaims stale locks with an atomic `rename(2)`; simultaneous starts and simultaneous stale reclaims have exactly one winner.
3. Each accepted wake batch persists its own operation identity and keeps it across retries and restarts; the retry comparison includes the prompt and pinned configuration digest.
4. The operation id is passed to Pi Durable as `requestId`, and an accepted-but-unsettled retry reconnects the original submission, retrieves its result, and settles exactly one outcome instead of returning `RECONCILE_REQUIRED`.
5. The outcome sink takes the operation id as an explicit operation key and appends atomically or returns the existing row, so distinct operations with identical text cannot collide.

## Read in order

1. `docs/pi-durable/01-project-design.md` … `04-evaluation-harness.md` — the captain's design package.
2. `docs/pi-durable/05-p0-source-verification.md` — verified upstream API and P0 experiments.
3. `docs/pi-durable/06-evaluation-report.md` + `docs/pi-durable/eval-results.json` — results and raw per-run records.
4. `runtime/pi-durable/` — the implementation.
5. `docs/pi-durable/development.md` — exact verified commands.

GitHub: [report](https://github.com/AndrewGoldfinch/firstmate/blob/experiment/pi-durable-supervision/docs/pi-durable/06-evaluation-report.md) · [P0 note](https://github.com/AndrewGoldfinch/firstmate/blob/experiment/pi-durable-supervision/docs/pi-durable/05-p0-source-verification.md) · [development](https://github.com/AndrewGoldfinch/firstmate/blob/experiment/pi-durable-supervision/docs/pi-durable/development.md).

## Commit map

| Phase | Commit(s) |
| --- | --- |
| Design docs (pre-existing) | `a40b9e37` |
| P0 verification | `577aacba`, `aa728937`, `8887578b`, `7333381e`, `2c339400` |
| P1A service + protocol + store lock | `1fa241dc` |
| P1B conversation identity + authority | `4cef87df` |
| P1C dispatch/outcome bridge + seam | `13650337`, `c24cad8b` |
| P1D bounded observation | `f054e8df` |
| P2 evaluation harness + report | `efda6d9e` |
| P2b coverage + pilot + calibration | `4e34845b`, `79c12f1a`, `fc620173`, `41397d8b`, `f891eb4c`, `b03e80a9`, `3bd13ea7`, `77b49eb0` |
| Reviewer summary + review fixes | `432126c9`, `05e81277` |

## How to verify

```sh
cd runtime/pi-durable
npm ci
npm run typecheck          # clean
npm test                   # 74/74
node --test tests/milestone.test.ts  # the reviewer's end-to-end milestone
node eval/main.ts          # regenerates docs/pi-durable/eval-results.json + report
```

`node eval/main.ts` also runs a bounded real-model pilot when a provider credential is reachable; otherwise it records the pilot as not-covered.
The Docker restart lane needs a running Docker daemon (verified against server 29.8.2).
The seam regressions are `tests/fm-pi-branch-extension.test.sh` and `tests/fm-branch-supervision.test.sh` (2/2 pass, run with `bin/fm-test-run.sh`).
Socket-dependent tests are environment-sensitive: the reviewer's environment blocked Unix-socket listeners (`listen EPERM`), so a run without socket support records those cases as not-covered rather than passing them.

## Results at a glance

- Fault matrix F01–F18: **14 pass, 0 fail, 1 not-covered, 3 known-gap** (F09 the documented routine-note delivery limitation; F16/F17/F18 marked known-gap because they exercise credential reachability, a container process/store restart, and a wrong-home refusal respectively, not the failure their titles once claimed).
- Grader negative controls: **4/4 rejected** (dropped row, injected effect, forged completion, swapped ack owner).
- Real-model pilot: **pass** — `opencode-go/muse-spark-1.3-contributor`, 6 calls, both arms completed all six tasks, 6/6 dispositions matched.
- Benefit: **initial contracts tested; important correctness gaps remain, benefit unproven** — recovery parity, recorded-fault parity, recovery time unproven (durable arm slightly slower), duplicate-outcome avoidance unproven. Thresholds calibrated over 10 runs (noise floor ~3%), but the manual-action count is a recorded-fault count rather than operator actions, the recovery-time comparison times whole scenarios whose faulted runs still include missing outcomes, and the duplicate comparison only subtracts total outcome counts between arms.
- Milestone verification: **pass** — two successive wakes, an execution crash with resume, and an ownership replacement were driven through the extension's durable-branch spawn path and the real sidecar; the outcome store was read back independently and showed exactly one outcome per accepted operation, no stale append, and distinct operation identities.

## P0 findings that shaped the adapter (confirm these)

- Pi Durable is a library, not a `pi` subcommand.
- `requestId` dedup returns the original submission, but a **changed payload under the same ID is silently accepted** — the adapter must digest-check and refuse it.
- The default SQLite store has **no cross-process lock** — the adapter must own a store-owner lock.
- Tool `replay` reruns only when declared safe; ungraceful-crash continuation works.
- Cancellation is cooperative via the context abort signal; the adapter must verify owned-process termination itself.
- Observation is snapshot + operations with **no replay log**; the adapter's outbox/receipts carry settlement.

## Known limitations / open items

- Arm A is a reduced model of the existing path, not the full pinned Pi supervision extension.
- The faux model returns fixture truth, so the harness measures execution durability, not model judgment.
- The container lane is a process/store boundary, not an OS reboot: it proves the store reopens and the recorded authority reconciles, not that a kernel or filesystem failure is survivable.
- The outcome sink is now keyed by the operation identity with an atomic append-or-return-existing, so two distinct operations with identical text no longer collide; the evaluation's duplicate-outcome comparison still only subtracts total counts between arms and does not establish the absence of duplicates.
- F16 does not inject a missing credential or incompatible dependency; it records whether a real credential was reachable.
- F18 sends a request with a different `homeId`; no store is restored into another home.
- Socket-dependent tests are environment-sensitive (the reviewer's environment blocked Unix-socket listeners with `listen EPERM`).
- The real-model pilot replays one shared answer set through both arms (not independent per-arm calls).
- Token/cost comparison and the operator-diagnosis study are out of scope for this pass.
- The P0 full-suite baseline is environment-limited and incomplete (see `05-p0-source-verification.md`).
- Not upstream: the OpenCode V2 port (`kunchenguid/firstmate#5143`) is still unmerged.

## Reviewer checklist

- [ ] With provider selection off, is the existing supervision path behaviorally unchanged? (`.pi/extensions/fm-branch-supervision.ts` around the `executionProvider()` branch)
- [ ] Are the adapter obligations enforced with tests — store-owner lock (simultaneous start and simultaneous stale reclaim), changed-payload/prompt/configuration conflict refusal, and operation identity per wake batch?
- [ ] Is ownership re-checked at the outcome mutation boundary, with a replacement test that refuses both the append and the receipt?
- [ ] Does the durable path route candidate results through the existing outcome sink without acknowledging wake rows or mutating the task lifecycle directly?
- [ ] Are the not-covered and known-gap cases honestly marked, never faked?
- [ ] Is there any arbitrary shell added? (There should be none.)
- [ ] Do the calibrated thresholds hold up against the measured noise floor?
