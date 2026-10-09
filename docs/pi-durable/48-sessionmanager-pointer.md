# Pi Durable: SessionManager pointer failure - scout report

Task: `pi-durable-sessionmanager-pointer` (read-only scout, deliverable = this report).
Constraints honored: no repository code changes, no SDK upgrade, no repinning, no expansion,
the running adoption home (`/home/andy/pi-durable-adoption`) was only read, never written.
All reproduction ran in scratch temp dirs. One scratch commit/revert is not needed; nothing in
the repository was modified.

## 1. Verdict

**Classification: harness assumption (a guard defect), not an SDK compatibility issue and not a
production-path defect.**

The "pointer" is the file `state/.branch-session` written by the Pi supervision-branch extension.
The opt-in live guard `tests/fm-pi-branch-live-e2e.test.sh` asserts that this file exists after
the branch's first (intentionally failing) prompt and reports its absence as
`real SessionManager did not persist the branch session pointer`.

That message is wrong. The extension writes the pointer only on the branch **success** path, after
`createAgentSession(...)` returns and lock ownership is re-confirmed. Any failure **before** that
write (prompt generation, model-pin resolution, lock loss, or a swallowed write error) produces the
same missing-file symptom, and the guard mislabels it as a SessionManager persistence failure while
it cannot tell the two apart.

With dependencies correctly resolved, the guard passes end to end against the real SDK 1.1.0, which
rules out an SDK-change cause. The extension's ordering is deliberate and its read of the pointer is
defensive, which rules out a production-path defect.

## 2. What the pointer is, where it is written, where it is read

Extension HEAD `1f3e7696`, `.pi/extensions/fm-branch-supervision.ts`:

- `.pi/extensions/fm-branch-supervision.ts:143-144`
  ```ts
  const sessionsDir = join(state, "branch-session");
  const sessionPointer = join(state, ".branch-session");
  ```
  `state = process.env.FM_STATE_OVERRIDE || `${fmHome}/state`` (line 141), `fmHome = FM_HOME || root`.

- Branch build, `createBranch` (around lines 1284-1405):
  - `1297-1303`: generate the branch prompt with `bin/fm-branch-prompt.sh`; **throws before anything
    is persisted** if the script fails or emits too little.
  - `1285` (`branchModelSelection`) / `preparePinnedBranchModel`: a model pin the runtime cannot
    resolve **throws before anything is persisted**.
  - `1309`: `SessionManager.open(branchSessionFile, sessionsDir)` only for a same-generation rebuild.
  - `1315`: `SessionManager.create(fmRoot, sessionsDir)`.
  - `1318`: `branchSessionFile = sessionManager.getSessionFile() ?? ""`.
  - `1375-1387`: `const created = await createAgentSession({ cwd, sessionManager, ... })`.
  - `1393-1396`:
    ```ts
    if (!(await actingAsOwner(branchGeneration))) {
      try { created.session.dispose(); } catch {}
      throw new Error("supervision session was replaced or lost lock ownership");
    }
    ```
  - `1398-1403`:
    ```ts
    try {
      writeFileSync(sessionPointer, `${sessionManager.getSessionFile()}\n`);
    } catch {
      // ... a failed write costs neither the live session nor its replacement.
    }
    ```

  So the pointer is written **only after** construction succeeded and ownership was re-confirmed,
  and even then a write failure is swallowed.

- Read side is defensive, `.pi/extensions/fm-branch-supervision.ts:866-878` (the effort picker's
  last-resort model lookup): `readFileSync(sessionPointer)` and `SessionManager.open(...)` are
  wrapped in `try { ... } catch { return undefined; }`. A missing pointer is a normal, handled
  input, not a failure.

Real SDK 1.1.0 `SessionManager` (`/home/andy/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`):

- `1316-1319` `static create(cwd, sessionDir, options)` normalizes `sessionDir` and constructs with
  `persist=true`.
- `713` `newSession()` sets `this.sessionFile = join(this.getSessionDir(), `<timestamp>_<id>.jsonl`)`.
- `1318` `getSessionFile()` returns `this.sessionFile` (`782-783`).
- `665-667` `_setSessionFile` resolves and loads/creates the file; `open` (`1326+`) behaves as the
  extension expects.

The SDK surface the extension uses (`create`, `open`, `getSessionFile`) is present and behaves
exactly as assumed in 1.1.0.

## 3. Reproduction

Host: Node `v22.21.1`, SDK `@earendil-works/pi-coding-agent` `1.1.0` at
`/home/andy/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent`.

### 3a. Baseline (registry deps unresolved) - the earlier dependency failure, for context

```
FM_PI_BRANCH_LIVE_E2E=1 FM_PI_PACKAGE_DIR=<release>/@earendil-works/pi-coding-agent \
  bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh
```
fails at import with `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/pi-ai'` because the
guard links deps from a nested `pi-coding-agent/node_modules` the 1.1.0 release does not have
(already characterized by the dependency-resolution report). This never reaches the pointer code.

### 3b. Dependency resolution satisfied -> full green (disconfirms SDK and production causes)

I built an SDK staging dir that preserves the nested dependency layout the guard links from
(`/tmp/pisdk/@earendil-works/pi-coding-agent` with `node_modules/@earendil-works/{pi-ai,pi-tui}`
and `node_modules/typebox` pointing at the real release copies), then ran the **unmodified tracked
guard**:

```
FM_PI_BRANCH_LIVE_E2E=1 FM_PI_PACKAGE_DIR=/tmp/pisdk/@earendil-works/pi-coding-agent \
  timeout 300 bin/fm-test-run.sh tests/fm-pi-branch-live-e2e.test.sh
```

Result `exit=0`; all seven probes pass, including the first probe that contains the pointer
assertion:

```
ok - real Pi SDK 1.1.0 accepts the branch session construction and preserves an unpromptable wake
ok - real Pi SDK 1.1.0 rejects a post-construction 429 to watcher-owned main delivery without losing its durable row
ok - real Pi SDK 1.1.0 applies an explicit branch model on create and over a reopened session's recorded model
ok - real Pi SDK 1.1.0 reports its own supported effort levels and applies an explicit branch effort over a reopened session's recorded level
ok - real Pi SDK 1.1.0 immediately renders appendEntry in the active transcript, persists it across reopen, and excludes it from model context
ok - real Pi SDK 1.1.0 queues a streaming-time watcher wake without before_agent_start, keeps the successor chain, and surfaces consumption of both follow-ups
ok - real Pi SDK 1.1.0 suppresses only empty or exact-repeat retry finals, retains first and differing replies after reopen, buffers retry streaming, and keeps outcomes retryable
```

The first probe asserts `existsSync(${home}/state/.branch-session)` and that the recorded path
starts with `${home}/state/branch-session/` and ends `.jsonl`
(`tests/fm-pi-branch-live-e2e.test.sh:207-217`). It passes on the real 1.1.0 SDK. The pointer is
therefore persisted correctly by the real SessionManager when the branch actually builds.

### 3c. Minimal reproduction of the reported failure signature

The reported message reproduces whenever the branch build fails before the pointer write. Smallest
lever: run the same unmodified guard from a scratch tree whose `bin/fm-branch-prompt.sh` exits 1,
which makes `createBranch` throw at `fm-branch-supervision.ts:1297-1303`.

Scratch tree `/tmp/ptrrepro`: every repository top-level entry symlinked from the real worktree
except `tests` (copied) and `bin` (real files symlinked, but `fm-branch-prompt.sh` replaced by a
script that prints `ptrrepro: forced prompt failure` and exits 1). The tracked guard runs unchanged.

```
cd /tmp/ptrrepro
FM_PI_BRANCH_LIVE_E2E=1 FM_PI_PACKAGE_DIR=/tmp/pisdk/@earendil-works/pi-coding-agent \
  timeout 300 bash tests/fm-pi-branch-live-e2e.test.sh
```

Exact output:

```
not ok - real-SDK Pi branch guard failed against pi-coding-agent 1.1.0: file:///tmp/ptrrepro/[eval1]:116
  throw new Error("real SessionManager did not persist the branch session pointer");
        ^

Error: real SessionManager did not persist the branch session pointer
    at file:///tmp/ptrrepro/[eval1]:116:9

Node.js v22.21.1
```

This is byte-for-byte the failure the dependency investigation recorded (same message, same
`[eval1]:116` frame). It is reached purely by failing the branch build, with no SDK or
session-management problem present. `[eval1]:116` is the guard's inline check at
`tests/fm-pi-branch-live-e2e.test.sh:207-208`.

## 4. Mechanism

Watcher/branch flow in the failing probe:

1. The watcher accepts the wake and dispatches a branch offer.
2. The branch offer is accepted and its settlement tracks `ensureBranch`/`createBranch`.
3. `createBranch` either throws (prompt failure, pin failure, lock loss) or completes construction
   and then writes `state/.branch-session`.
4. The guard waits for watcher-owned main delivery, then obtains `offers[0].settlement` (an
   `Error` in both cases) and only checks `instanceof Error` - it never inspects the failure reason.
5. It then asserts the pointer file exists.

When construction succeeded and the first prompt failed (the probe's intended path), the settlement
rejects with a prompt error and the pointer exists -> pass. When construction itself failed, the
settlement also rejects with an `Error` and the pointer does not exist -> the guard prints the
misleading SessionManager message. The two are indistinguishable at the guard's assert site because
the guard discards the settlement's message and treats "pointer exists" as a proxy for "SessionManager
persisted".

The same symptom is reachable from a swallowed pointer-write failure (`1398-1403`), because the
extension intentionally ignores write errors.

## 5. Why it is a harness assumption, with the distinguishing evidence

- **Not an SDK compatibility issue.** The real 1.1.0 `SessionManager.create` sets a session file and
  `getSessionFile()` returns it (§2), and the unmodified guard with correctly resolved deps passes all
  seven probes, pointer assertion included (§3b). If the SDK had changed under the harness, §3b
  could not pass.
- **Not a production-path defect.** The extension writes the pointer only on the success path by
  design, and reads it defensively with a "no recorded model" fallback (§2). A missing pointer is a
  handled input to the shipped code; it does not break branch creation, wakes, or fallback.
- **Harness assumption.** The guard's assertion and its error text encode "branch construction
  succeeded" as "the pointer file exists", which is false: the file is a success-path side effect
  written after `createAgentSession` and the ownership recheck. The guard already has the precise
  result in `offers[0].settlement`; it discards it and asserts an unrelated side effect, then names
  the wrong subsystem.

## 6. Blast radius

- The failing assertion lives only in the opt-in live guard
  `tests/fm-pi-branch-live-e2e.test.sh:207-208` (message) and `213-217` (placement).
- The same file `tests/fm-pi-branch-extension.test.sh:3308-3380` asserts the pointer too, but that is
  the stubbed (non-live) guard, so it is not affected by real-SDK behavior.
- The in-flight home revision (`experiment/pi-durable-durable-mode-persist`) adds
  `tests/fm-pi-phase1-pilot.test.sh` and `tests/fm-pi-phase1-live-session.test.sh`, neither of which
  asserts `.branch-session` (checked against the branch tree); no second home in this worktree
  carries the assertion.
- Production behavior: none. A missing/stale pointer only degrades the effort picker's last-resort
  model lookup to `undefined`, which the extension already handles.

## 7. What a fix would touch (not implemented)

The smallest correct fix is in the guard, not in session management:

- At `tests/fm-pi-branch-live-e2e.test.sh:207-208`, stop using pointer existence as the success
  signal. Assert on the branch **construction** outcome - the offer settlement for the first probe is
  the intended "unpromptable branch" rejection, so read `offerFailure.message` and require it to name
  the expected prompt/model failure, then check the pointer.
- Alternatively (or additionally) have the extension record a build-failure marker or always write
  the pointer path before it can throw, so "construction failed" and "pointer not persisted" are
  distinguishable. That is a shipped-extension change and is explicitly out of this task's scope.
- No change to `SessionManager` wiring, the model/effort pins, or the branch lifecycle is required.

## 8. Related, separate finding (dependency fix is not yet sufficient)

The guard's own effort probe hardcodes the nested layout independently of the extension symlinks:

- `tests/fm-pi-branch-live-e2e.test.sh:563-569`
  ```js
  const packageRoot = process.env.PI_PACKAGE_DIR;
  ... await import(pathToFileURL(`${packageRoot}/node_modules/@earendil-works/pi-ai/dist/compat.js`).href)
  ```

On the 1.1.0 hoisted install `$PI_PACKAGE_DIR/node_modules` does not exist. In my scratch
reproduction with the guard's symlinks corrected to the hoisted layout (the correction recommended
by the dependency report), the first probe passed but the **effort probe failed** with:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js'
```

So the dependency-resolution fix as written (repoint the guard's `ln -s` lines) makes the extension
imports resolve but does not by itself produce a fully green live guard; line 569 must also resolve
`compat.js` from the release top level (or `PI_PACKAGE_DIR` must be staged with a nested
`node_modules`). This is separate from the pointer failure but is on the same critical path for a
green live run.

## 9. What remains unverified

- The dependency report does not record the exact scratch commands behind its pointer-failure
  observation ("temp dir, symlinked repo tree, corrected 4a+4b"). I could not reconstruct which
  pre-write failure it hit. I reproduced the identical message and `[eval1]:116` frame by failing the
  branch build (forced prompt failure) and by no other means. The evidence presented here pins the
  **mechanism and classification**; the scout's specific trigger is inferred, not preserved.
- I could not run the adoption home's exact revision `03073d06` (it is not in this clone; the local
  `experiment/pi-durable-durable-mode-persist` tip is `2b8d9c16`). That revision's guard also imports
  an extra lib (`fm-execution-provider.ts`) not in the HEAD guard's copy list, so it must be run with
  its own guard. The failure's classification is revision-independent given the extension ordering.
- The environment-difference hypothesis in the earlier report (ambient model credentials, Node
  version) is not reproduced: an ambient `FM_STATE_OVERRIDE` breaks the guard earlier ("watcher did
  not arm"), and this host has no `FM_STATE_OVERRIDE`; the green run shows the pointer is written with
  the same constraints.
- The phase1 guards on the in-flight home revision were not executed (they need credentials/live
  model calls); only inspected for the pointer assertion.

## 10. Recommendation

1. Treat the pointer failure as a **guard defect**, not a Pi/SDK regression: fix the guard so it
   asserts the branch construction result rather than `.branch-session` existence, and make its error
   text name the actual construction failure.
2. Do **not** change session-management behavior in production for this: the extension ordering and
   defensive pointer read are correct for their contract.
3. On the dependency fix task, also correct `tests/fm-pi-branch-live-e2e.test.sh:563-569`
   (`compat.js` resolution), otherwise the live guard still cannot reach a full green run on the
   1.1.0 hoisted layout even after the symlink correction.

This is a small, clear guard fix and a good candidate for promotion to a ship task after the
dependency fix lands; no session-management behavior is implicated.
