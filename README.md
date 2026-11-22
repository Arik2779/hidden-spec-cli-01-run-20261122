# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Arik2779/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Arik2779/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in
four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON — and `mend` reads all four to one written
contract, finds the lines an edit names even when the model drifted their whitespace or
indentation, and changes every file or none.

Built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
Repository: [Arik2779/hidden-spec-cli-01-run-20261122](https://github.com/Arik2779/hidden-spec-cli-01-run-20261122).

## Run it

```sh
node main.ts patch.diff
```

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When `PATCH` is
  absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`;
  `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file
  is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Exit codes and output

- Exit 2, one line, nothing written: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.
- Exit 1, nothing written: one line `error: <code> <path>` per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then
  `failed: <k> of <n> edits`. When any edit failed, no file is written.
- Exit 0: one line per changed path — `A <path>`, `D <path>`, `M <path>`, or
  `R <old> -> <new>` for a move — then `ok: <n> files` (or `ok: 1 file`).

## The four formats

- **Unified diffs** — sections (`diff --git`, `---`/`+++`, `rename from`/`to`, `new`/`deleted
  file mode`), hunks with wrong line numbers (the occurrence nearest the hunk's line is taken),
  creation, deletion, moves, and `\ No newline at end of file`.
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines, `=======`, new lines,
  `>>>>>>> REPLACE`; the old lines must occur exactly once.
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with `*** Add File:`,
  `*** Delete File:` and `*** Update File:` sections, `@@` anchors, a cursor that walks the
  file, `*** End of File` chunks, and `*** Move to:`.
- **JSON edits** — one JSON array of edit objects, or JSON Lines: `create`, `str_replace`
  and `insert`.

## Matching

Old lines are found at the first of three tiers at which they occur at least once: tier 0
(exact), tier 1 (trailing spaces and tabs stripped), tier 2 (leading and trailing spaces and
tabs stripped). At tier 2, new lines are re-indented to the file's indentation. Context lines
are always written as the file's own lines.

## Requirements

Node 22 and its standard library only — no dependencies, no network, no model calls.
`runner.ts` is the kit's trial runner, kept unchanged; `check.ts` runs the 100-check practice
set (`node check.ts <practice.json>`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=808mq1jq&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
