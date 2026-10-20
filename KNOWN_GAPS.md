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

## G2 · fixed · 2026-10-20 · LOW
- Task: Retire the old setup: remove restore, the first-install backup and old-setup checks
- Where: DESIGN.md:395
- Problem: F1: Retirement documentation remains incomplete
- Trigger: A reader consults the switch instructions or README.
- Fix: Remove the obsolete switch-back instruction and add a short retirement notice to README.md.
- Log: 20261020223751-b2636e
- Why skipped: labelled GAP by the reviewer; harm: Documentation still describes a removed recovery command and omits the requested retirement notice from README.

## G3 · open · 2026-10-20 · LOW
- Task: Retire the old setup: remove restore, the first-install backup and old-setup checks
- Where: tests/install.test.js:88
- Problem: F2: T1 bypasses the prerequisite and test-run checks it promises
- Trigger: The planned T1 installation test runs with checks:false.
- Fix: Run T1 with checks enabled, stub successful prerequisite and test subprocesses, and assert their order relative to approval and writes.
- Log: 20261020223751-b2636e
- Why skipped: labelled GAP by the reviewer; harm: The promised validation of prerequisites, tests and installation order is absent.

## G4 · open · 2026-10-20 · LOW
- Task: Retire the old setup: remove restore, the first-install backup and old-setup checks
- Where: tests/doctor.test.js:195-206
- Problem: F1: T1 never seeds live project state
- Trigger: The successful installed-copy test takes its preservation snapshot.
- Fix: Seed a valid project state.json before taking the snapshot.
- Log: 20261020225301-8a8fb5
- Why skipped: pair: both

## G5 · open · 2026-10-20 · LOW
- Task: Retire the old setup: remove restore, the first-install backup and old-setup checks
- Where: tests/doctor.test.js:47
- Problem: F2: Non-live preservation checks omit config.json
- Trigger: T2, T3 and T5 call untouched() around doctor without --live.
- Fix: Also snapshot and compare config.json bytes in each non-live preservation test.
- Log: 20261020225301-8a8fb5
- Why skipped: pair: both

## G6 · open · 2026-10-20 · MEDIUM
- Task: Retire the old setup: remove restore, the first-install backup and old-setup checks
- Where: -
- Problem: F3: R6 is PARTIAL
- Trigger: the task as asked
- Fix: -
- Log: 20261020225301-8a8fb5
- Why skipped: pair: disputed by A: KNOWN_GAPS.md:14 and :23 preserve the compatible format. Supplied evidence reports 79 passing tests. An independent rerun being unavailable is a verification limitation; it establishes neither a violated R6 constraint nor the claimed behavioral failure.
