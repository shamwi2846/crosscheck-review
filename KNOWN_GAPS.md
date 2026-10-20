# Known gaps

Findings left unfixed on purpose. Entries are never deleted, only marked fixed.

## G1 · open · 2026-10-20 · LOW
- Task: -
- Where: tests/install.test.js:89
- Problem: the hook-placement assertion calls h.command.startsWith on every retained hook, so a fixture hook without a command would throw
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: the fixture has no such hook; adding one would make the test fail loudly, never pass wrongly
