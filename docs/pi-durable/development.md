# Pi Durable development and verification commands

Verified on 2026-10-03 against the pinned baseline and experiment head (see `05-p0-source-verification.md`).
This file records only commands that were actually run; add new verified commands here as P0 completes.

## Checkout and pins

The prototype develops in the FirstMate fork on `experiment/pi-durable-supervision`, with the fork's default branch kept aligned to upstream.

| Item | Value |
| --- | --- |
| Upstream remote | `upstream` = `https://github.com/kunchenguid/firstmate` |
| Fork remote | `origin` = `git@github.com:AndrewGoldfinch/firstmate.git` |
| Experiment branch | `experiment/pi-durable-supervision` |
| Baseline branch | `origin/experiment/pi-durable-baseline` |
| Baseline commit | `1f3e769616fdf9f31f85f4c3e6a9f71606634238` (equals upstream `main` at P0 start) |
| Experiment head at P0 start | `a40b9e375330773e61fcf19bdb894e31ed96d3eb` (design docs only) |

```sh
git clone git@github.com:AndrewGoldfinch/firstmate.git <dir>
git -C <dir> remote add upstream https://github.com/kunchenguid/firstmate
git -C <dir> fetch --all --prune
git -C <dir> checkout -B experiment/pi-durable-supervision origin/experiment/pi-durable-supervision
```

## Toolchain

| Tool | Version observed | Notes |
| --- | --- | --- |
| Node | v22.21.1 (nvm) | runs the Pi extensions |
| `pi` | 1.0.0 | installed at `/home/andy/.nvm/versions/node/v22.21.1/bin/pi` |
| `@earendil-works/pi-coding-agent` | 1.0.0 | global npm install |
| `@earendil-works/pi-durable` | 1.0.1 | the Durable runtime library (not a `pi` subcommand) |
| `@earendil-works/pi-ai` / `@earendil-works/chord` | 1.0.1 / 1.0.1 | Durable dependencies |
| ShellCheck | 0.11.0 | `bin/fm-lint.sh --required-version`; installed at `~/.local/bin/shellcheck` |
| actionlint | 1.7.12 | `bin/fm-lint-workflows.sh --required-version`; installed at `~/.local/bin/actionlint` |
| Upstream Pi commit (durable/ai/chord) | `a7229ddc21810d6245105978033b7df645ecc2f7` | `gitHead` of all three 1.0.1 packages |
| Node engine floor | `>=22.19.0` | declared by `@earendil-works/pi-durable` |

There is no repository build step: FirstMate is bash `bin/` scripts plus TypeScript Pi extensions under `.pi/` that the Pi runtime loads directly.

## Lint

```sh
bin/fm-lint.sh                 # single owner of the lint definition (ShellCheck + workflows + backend purity)
bin/fm-lint.sh --required-version
bin/fm-lint-workflows.sh --required-version
```

## Tests

```sh
bin/fm-test-run.sh tests/<subject>.test.sh        # one subject, timed
bin/fm-test-run.sh tests/<a>.test.sh tests/<b>.test.sh
bin/fm-test-run.sh --changed                      # changed-file-informed, bounded concurrency
bin/fm-test-run.sh --all                          # deliberate full regression (not the gate Test step)
```

`CONTRIBUTING.md` and `docs/fm-test-portable-shards.md` own the full runner contract.

## Baseline capture (2026-10-03)

Pinned supervision-branch tests, run from the experiment checkout:

```sh
bin/fm-test-run.sh tests/fm-branch-supervision.test.sh tests/fm-pi-branch-extension.test.sh
```

Result: `FM_TEST_SUMMARY total=2 failed=0`, ~94 s wall (2026-10-03T23:16Z). Both subjects passed.

Lint:

```sh
bin/fm-lint.sh
```

Result: passes in changed-file mode (ShellCheck 0.11.0, actionlint 1.7.12; 3 workflow files valid). Full-suite (`--all`) capture is an open P0 item.

Durable probe lab (throwaway, outside this repo):

```sh
mkdir -p ~/dev/pi-durable-lab && cd ~/dev/pi-durable-lab
npm init -y && npm install @earendil-works/pi-durable@1.0.1 @earendil-works/pi-ai@1.0.1 @earendil-works/chord@1.0.1
```

See `05-p0-source-verification.md` for the probe results.

## Deterministic Durable tests (faux model)

No real model or credentials are needed: use Pi's faux provider.

```js
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall("my_tool", {})], { stopReason: "toolUse" }), fauxAssistantMessage("final")]);
```

Note: a turn that calls a tool must set `{ stopReason: "toolUse" }`. With the default `"stop"`, the harness treats the message as the final answer and never runs the tool (observed directly).

## P1A sidecar (`runtime/pi-durable`)

The P1A service, protocol, and single-owner store lock live in `runtime/pi-durable/`.
It is a Node package with pinned dependencies and no compile step, because Node 22.21.1 runs the TypeScript directly through type stripping.
The service opens the upstream Durable SQLite conversation store through `provider.ts`, keeps its own acceptance store, and binds a private Unix-domain socket per canonical `FM_HOME`.
It is opt-in and is not wired into the existing Pi supervision path; the provider seam belongs to P1C.

```sh
cd runtime/pi-durable
npm ci                 # uses the committed package-lock.json; npm install also works
npm run typecheck      # tsc --noEmit -p tsconfig.json
npm test               # node --test tests/*.test.ts
```

Result on 2026-10-04: `npm run typecheck` exits 0, and `npm test` reports 25 tests, 25 pass, 0 fail.
The suite covers the P1A acceptance gate: two owner processes cannot open one store (in-process and cross-process), a wrong home or an incompatible protocol is refused, a repeated operation ID returns the original acceptance without a new execution, a changed payload or configuration under the same ID is refused, no secret reaches the store file, diagnostics, or a reply, and the message-size and outstanding-operation bounds hold.
