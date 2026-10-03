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
