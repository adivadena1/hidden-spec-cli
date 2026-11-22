[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adivadena1/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adivadena1/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format. `mend` reads a patch — a unified
diff (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A patch,
or JSON tool calls — finds the lines each edit names even when the model
drifted their whitespace or indentation, and changes every file or none.

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format". Referral:
https://make.fun/r/3txr3dna

## Run

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a file, or stdin when it is absent or `-`. Options:

- `--format=NAME` — `auto` (default), `unified`, `search-replace`, `v4a`, `json`
- `--check` — report what would change, write nothing
- `--strict` — match at tier 0 (exact) only

## How it works

Four readers turn a patch into edits; one engine applies them to an
in-memory tree and writes the result only when every edit succeeded.

- **Matching** happens at the first of three tiers that finds the old
  lines: exact, trailing whitespace stripped, then leading and trailing
  whitespace stripped. Context lines are written back as the file's own
  lines; at tier 2 the other new lines are re-indented to the file's
  indentation.
- **Safety first.** Every path an edit names is checked before anything
  else: a path that leaves the tree (`..`, a leading `/`, an empty or
  `.` segment, a backslash) is refused, as is creating over an existing
  file or directory, or changing, deleting or moving a file that is not
  there.
- **All or nothing.** When any edit fails, no file is written, and the
  report lists one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. A write failure restores every file touched
  so far and is reported as `error: write <path>`.
- **Output** lists what changed, in byte order of path: `A`, `D`, `M`,
  or `R <old> -> <new>` for a genuine move, then `ok: <n> file(s)`.

## Files

- `main.ts` — the tool (Node 22 standard library only)
- `runner.ts`, `check.ts` — the kit's runner and checker (unchanged)
- `test/adversarial.json` — extra checks kept with the entry

## License

MIT — see [LICENSE](LICENSE).
