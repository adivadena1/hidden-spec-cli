# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adivadena1/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adivadena1/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one command-line tool that applies the edits AI models write, in
four formats, to a tree of files — to the specification in `SPEC.md` of the
[hidden-spec-cli-01-run-20261122 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):

- **unified diffs** (often with wrong line numbers),
- **SEARCH/REPLACE blocks**,
- **V4A patches** (`*** Begin Patch` … `*** End Patch`),
- **JSON edits** (a single array, or one edit object per line).

It finds the lines each edit names at the first of three matching tiers
(exact, trailing whitespace ignored, leading and trailing whitespace
ignored), and writes every change or none of them.

## Run it

Node 22, standard library only, nothing to install:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a path relative to the working directory (the tree root), or `-`
or absent for stdin. `--format` is one of `unified`, `search-replace`,
`v4a`, `json`, or `auto` (the default: detect from the patch text).
`--check` does everything but write. `--strict` matches at tier 0 only.

Exit codes: `0` when every edit applied (and, unless `--check`, was
written), `1` when at least one edit failed (nothing written), `2` for
usage, missing patch, unknown format, or parse errors. Stdout lists what
changed (`A`/`D`/`M`, `R old -> new` for a move) or why it failed, then a
one-line summary.

## Test it

```
node check.ts ../program/generator/practice.json   # 100 practice checks
node check.ts test/adversarial.json                # 66 adversarial checks
```

Both must pass 100%. The adversarial set pins down sentences of `SPEC.md`
the practice set does not show (see `BUILD-REPORT.md` in the garapan note
for the design and the open questions).

## Files

- `main.ts`: the CLI. Every parser normalizes its format to the same list
  of `Edit`s; one engine (`applyEdit`) executes them against the tree.
- `runner.ts`: kit plumbing, kept as it is. In a trial it reads the checks
  from the env, runs `node main.ts` on each one in a fresh directory, and
  posts what main.ts did.
- `check.ts`: the practice/adversarial runner for your own machine.
- `test/adversarial.json`: 66 regression checks for SPEC sentences the
  practice set does not cover.
- `LICENSE`: MIT.
