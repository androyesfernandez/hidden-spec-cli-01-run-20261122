# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/androyesfernandez/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/androyesfernandez/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files, in any of
the four formats models write edits in: a unified diff (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. It finds the lines each edit names at the first of three
matching tiers — exact, trailing-whitespace-insensitive, then
indentation-insensitive with re-indenting — and writes every change or none.
`SPEC.md` is the whole contract.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory; when it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a` or
  `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for
a move) and `ok: <n> files`. Exit 1 lists each failed edit and
`failed: <k> of <n> edits`, and writes nothing. Exit 2 reports a usage,
missing-patch, format or parse error on one line.

Node 22 and its standard library only; nothing is installed. `runner.ts` is
the kit's trial runner, kept as shipped; `check.ts` runs the 100 public
practice checks from `program/generator/practice.json` in the kit:

    node check.ts <practice.json>

## Practice score

100 of 100 practice checks pass (score 1000): unified 30/30,
search_replace 20/20, v4a 20/20, json 15/15, cli 15/15.
