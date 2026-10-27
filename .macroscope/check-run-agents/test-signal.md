---
title: Test Signal
model: gpt-6-sol
effort: max
input: incremental
tools:
  - browse_code
  - modify_pr
# An explicit include overrides ignore.md, which skips test files for every other check.
include:
  - "**/*.test.*"
exclude:
  - ".repos/**"
requires:
  - Check
maxBudgetPerRun: 2
maxBudgetPerPR: 10
conclusion: neutral
---

# Test signal review

Review only the tests this pull request adds or grows. Tests it moves, renames, or deletes are not findings. The rules are in `docs/internals/testing.md` under `## What to test`; read that section first and hold new tests to it.

## Checklist

Flag a new or grown test when one of these is true:

- It tests what types already guarantee, trivial logic, copy text, a smoke run, mock calls that mirror the implementation, callback wiring, or props rendered to static markup.
- An existing test or table in the same file already covers the behavior. The case belongs there as a row or an assertion.
- The same case is also tested at another layer, for example in a service test and its wrapper test, at each call site of one helper, or in web and mobile copies of the same logic. Keep one copy at the lowest layer that fails on `main`.

## Reporting

Post each finding as a brief inline comment on the new test. Name the rule and give one fix: fold the case into the named test or table, delete it, or keep the copy at the named layer and delete the others. Ask only for fewer or smaller tests, never for more coverage.

When there are no findings, make the entire final response exactly `All clear` on one line with nothing else.
