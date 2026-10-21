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

## G7 · fixed · 2026-10-21 · LOW
- Task: Final full audit of crosscheck as it is now
- Where: src/doctor.js:146
- Problem: F7: Doctor can modify the shared cooldown
- Trigger: A doctor --live probe receives a usage-limit or login failure.
- Fix: Let doctor probes report these failures without persisting the shared cooldown.
- Log: 20261021002711-74e504
- Why skipped: labelled GAP by the reviewer; harm: The diagnostic changes global.json and blocks subsequent GPT runs for 15 minutes, beyond its permitted verification update.

## G8 · fixed · 2026-10-21 · LOW
- Task: Final full audit of crosscheck as it is now
- Where: DESIGN.md:96
- Problem: F8: The documented close command uses unsupported dispositions
- Trigger: An operator follows the documented example for an open BUG.
- Fix: Use the accepted gap syntax and explain that verified fixes need no close note.
- Log: 20261021002711-74e504
- Why skipped: labelled GAP by the reviewer; harm: The documented command is refused.

## G9 · fixed · 2026-10-21 · LOW
- Task: Final full audit of crosscheck as it is now
- Where: DESIGN.md:20
- Problem: F9: Task freshness documentation contradicts review acknowledgement
- Trigger: Notes are updated while a review runs, following the documented claim that Notes edits do not stale reviews.
- Fix: Clarify that plans and skips depend on requirements, while any task-file change during a review prevents acknowledgement.
- Log: 20261021002711-74e504
- Why skipped: labelled GAP by the reviewer; harm: The operator unexpectedly receives no acknowledgements and must repeat the review.

## G10 · fixed · 2026-10-21 · LOW
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: src/review.js:148-149
- Problem: F4: Foreign-session checks omit escalated chain files
- Trigger: An unpaired chain contains an escalated file owned by session B and another eligible file; its chain belongs to session A.
- Fix: Check foreign-session changes across all c.files before filtering out escalated files.
- Log: 20261021011209-ea5a60
- Why skipped: pair: both

## G11 · open · 2026-10-21 · LOW
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: DESIGN.md:235-248
- Problem: F5: Required safeguard descriptions remain incomplete
- Trigger: An operator consults DESIGN.md or the installed RULES.md for the behavior required by R1–R6.
- Fix: Add the missing R1–R6 descriptions to the two documents.
- Log: 20261021011209-ea5a60
- Why skipped: pair: both

## G12 · fixed · 2026-10-21 · LOW
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: KNOWN_GAPS.md:59-84
- Problem: F6: The required F6 gap disposition is absent
- Trigger: The task intentionally leaves the planless plan-exit behavior unchanged.
- Fix: Record F6 as a GAP with the specified installed-version evidence, leaving the hook behavior unchanged.
- Log: 20261021011209-ea5a60
- Why skipped: pair: both

## G13 · open · 2026-10-21 · HIGH
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: src/codex.js:190-198
- Problem: F1: Polling still loses helpers that exit between snapshots
- Trigger: After a process snapshot, a helper starts a detached worker and exits before the next two-second snapshot.
- Fix: Retain process-start lineage for computer runs so helpers remain discoverable even when their entire lifetime falls between snapshots. — test: After the first process notification, start a helper that immediately spawns a detached worker and exits without waiting for another notification. Verify the worker is recorded and stopped with the run, and retains desktop ownership if only the driver is killed.
- Log: 20261021013031-5c83d6
- Why skipped: the owner chose on 2026-10-21 to record it rather than add a job object: a process that GPT's shell starts through a helper exiting within one 2-second watch can outlive a computer run (a live read-only Codex run proved a sandboxed Start-Process can leave one running); closing it fully needs admin-only process-creation events or a kill-on-close job object around Codex; the computer-use workers themselves are direct children of tracked processes, and neither model trades or moves money

## G14 · fixed · 2026-10-21 · LOW
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: src/review.js:144-150
- Problem: F3: An entirely escalated chain hides the foreign-session filename
- Trigger: Every file in an unpaired chain is escalated, and another session owns a pending change in one of them.
- Fix: Check foreign-session records before the empty-scope and busy returns.
- Log: 20261021014906-8a03cf
- Why skipped: pair: both

## G15 · open · 2026-10-21 · LOW
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: -
- Problem: F4: RULES.md still omits required safeguard descriptions
- Trigger: An operator reads the installed RULES.md.
- Fix: Add short descriptions of R1, R2, R4 and R6 to RULES.md.
- Log: 20261021014906-8a03cf
- Why skipped: pair: both

## G16 · fixed · 2026-10-21 · LOW
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: -
- Problem: F5: The required planless-exit gap disposition is still absent
- Trigger: F6 is intentionally left unchanged.
- Fix: Record F6 as a GAP with the 2.1.295 and 2.1.299 observations that recorded exits contain plan and planFilePath; leave hook and doctor behavior unchanged.
- Log: 20261021014906-8a03cf
- Why skipped: pair: both

## G17 · open · 2026-10-21 · HIGH
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: src/codex.js:224-225
- Problem: F1: Helpers that exit between snapshots still lose their workers
- Trigger: Between two snapshots, a helper starts a detached worker and exits before it is noted.
- Fix: Place computer runs in a kill-on-close Windows job and use its membership for process ownership, so an exited helper cannot sever ownership. — test: After the first snapshot, start a helper that immediately creates a detached worker and exits without waiting for another snapshot. Verify the worker is tracked and stopped with the run, and desktop access cannot reopen while it survives.
- Log: 20261021021243-57edd7
- Why skipped: the same leftover-process case as G13, recorded by the owner's decision on 2026-10-21 instead of a kill-on-close job object: a process that GPT's shell starts through a helper exiting within one 2-second watch can outlive a computer run; the computer-use workers themselves are direct children of tracked processes, and neither model trades or moves money

## G18 · open · 2026-10-21 · HIGH
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: src/codex.js:220-224
- Problem: F1: Windows cleanup loses descendants whose unrecorded parent exited
- Trigger: After the initial process snapshot, Codex starts an intermediary that launches a persistent worker and exits. Codex then exits.
- Fix: Retain process ancestry throughout the run, including exited intermediaries, and use that retained ancestry for cleanup and desktop ownership. — test: On Windows, launch an intermediary after the initial snapshot, have it start a persistent worker and exit, then end Codex. Verify the worker is terminated and desktop ownership cannot be released while it survives.
- Log: 20261021020028-4b4180
- Why skipped: partly fixed (a computer run now notes its processes from its start and every 2 seconds, keeping exited parents); the rest is the leftover-process case the owner chose on 2026-10-21 to record (G13) rather than add a kill-on-close job object

## G19 · open · 2026-10-21 · MEDIUM
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: src/hook.js:165
- Problem: F6: A planless ExitPlanMode request bypasses the review gate
- Trigger: ExitPlanMode supplies no nonempty plan and its plan file is absent or empty. The installed Claude Code permits an ordinary session to exit in this state.
- Fix: Return a normal denial requesting a saved, reviewed or skipped plan when the supplied plan is missing or empty; retain fail-open handling for hook errors.
- Log: 20261021020028-4b4180
- Why skipped: the plan gate is a workflow gate, not money, data or security code; every ExitPlanMode call recorded on this PC (Claude Code 2.1.295 and 2.1.299) carried plan and planFilePath, a planless exit still shows a warning, and the owner approves every plan

## G20 · open · 2026-10-21 · MEDIUM
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: -
- Problem: F12: R1 is PARTIAL
- Trigger: the task as asked
- Fix: -
- Log: 20261021020028-4b4180
- Why skipped: the same leftover-process case as F1 and G13

## G21 · open · 2026-10-21 · MEDIUM
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: -
- Problem: F13: R7 is PARTIAL
- Trigger: the task as asked
- Fix: -
- Log: 20261021020028-4b4180
- Why skipped: RULES.md says what Claude does and DESIGN.md says how crosscheck does it (section 15 keeps driver details out of the rules), so these behaviors are described in DESIGN.md only

## G22 · fixed · 2026-10-21 · MEDIUM
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: -
- Problem: F14: R8 is PARTIAL
- Trigger: the task as asked
- Fix: -
- Log: 20261021020028-4b4180
- Why skipped: F6's reason is recorded by this close

## G23 · open · 2026-10-21 · LOW
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: KNOWN_GAPS.md:185-192
- Problem: F2: RULES.md still omits required safeguards
- Trigger: An operator reads the installed RULES.md.
- Fix: Add concise descriptions of those four safeguards to RULES.md.
- Log: 20261021022835-a47d94
- Why skipped: labelled GAP by the reviewer; harm: The required operating documentation remains incomplete.

## G24 · open · 2026-10-21 · HIGH
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: KNOWN_GAPS.md:113-120
- Problem: F1: R1 still loses workers launched by helpers between polls
- Trigger: On Windows, a helper starts after one process snapshot, launches a persistent worker, and exits before the next snapshot.
- Fix: Track computer runs with a kill-on-close Windows job, using its process membership for ownership and cleanup. — test: After the first snapshot, launch a helper that immediately starts a persistent worker and exits without waiting for another snapshot. Verify the worker is recorded, stopped with the run, and retains desktop ownership if the driver is killed.
- Log: 20261021022835-a47d94
- Why skipped: the leftover-process case already recorded as G13 by the owner's decision on 2026-10-21 (a process that GPT's shell starts through a helper exiting within one 2-second watch can outlive a computer run; closing it needs admin-only process events or a kill-on-close job object)

## G25 · open · 2026-10-21 · LOW
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: -
- Problem: F2: RULES.md still omits four required safeguards
- Trigger: An operator reads the installed RULES.md.
- Fix: Add concise descriptions of R1, R2, R4 and R6 to RULES.md.
- Log: 20261021023818-17bde4
- Why skipped: pair: both

## G26 · open · 2026-10-21 · LOW
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: -
- Problem: F1: RULES.md still omits four required safeguards
- Trigger: An operator reads the installed RULES.md.
- Fix: Add concise descriptions of R1, R2, R4 and R6 to RULES.md.
- Log: 20261021025304-008deb
- Why skipped: labelled GAP by the reviewer; harm: The required operating documentation remains incomplete.

## G27 · open · 2026-10-21 · LOW
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: -
- Problem: F1: RULES.md still omits four required safeguards
- Trigger: An operator consults the installed RULES.md.
- Fix: Add concise descriptions of R1, R2, R4 and R6 to RULES.md.
- Log: 20261021032254-10a5f9
- Why skipped: labelled GAP by the reviewer; harm: The required operating documentation remains incomplete.

## G28 · open · 2026-10-21 · HIGH
- Task: Fix the final audit's bugs, and stop crosscheck's own gap entries needing another review
- Where: -
- Problem: F1: R1 still loses workers whose helpers exit between samples
- Trigger: On Windows, a helper starts between process samples, launches a persistent worker, and exits before the next sample.
- Fix: Assign computer runs to a Windows job before their children start, and use its process membership for cleanup and desktop ownership. — test: Between two samples, launch a helper that immediately starts a persistent worker and exits, without waiting for discovery. Verify normal completion stops the worker and forced driver termination never permits desktop access while the worker remains alive.
- Log: 20261021032842-a41832
- Why skipped: the leftover-process case recorded as G13 by the owner's decision on 2026-10-21 (a process that GPT's shell starts through a helper exiting within one 2-second watch can outlive a computer run; closing it needs admin-only process events or a kill-on-close job object)

## G29 · open · 2026-10-21 · LOW
- Task: -
- Where: src/codex.js:224-225
- Problem: A computer run's 2-second process check runs PowerShell synchronously, holding the driver's event loop for about 0.5-2 s per check (up to its 15 s timeout if a scan stalls)
- Trigger: any computer run on Windows
- Fix: an asynchronous scan, or a longer interval, if a delay is ever measured to matter
- Log: CodeRabbit PR 14
- Why skipped: harmless as it is: Codex's output is buffered in its pipes and the timeout and grace timers only fire that much later; keeping it synchronous also means no scan result can arrive after the run settles (CodeRabbit nitpick on PR 14)

## G30 · open · 2026-10-21 · LOW
- Task: -
- Where: src/answer.js:89
- Problem: The round-limit check catches only plain wordings (round limit, the limit of three rounds, the limit was reached after three rounds); a concession worded otherwise, such as 'no further follow-up is allowed after three rounds', passes (CodeRabbit on PR 14).
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: GPT's narrow-round prompt itself says 'the round limit is reached', so the plain echo is what is caught; CONCEDE is defined as 'never real' and Claude verifies every finding; reading every phrasing is what DESIGN.md section 14 fact 7 rules out.

## G31 · fixed · 2026-10-21 · LOW
- Task: Split the two slowest test files so the suite runs faster
- Where: -
- Problem: F1: Timing evidence does not establish balance or speedup
- Trigger: Validating R1 against the supplied 67-second full-suite result.
- Fix: Record comparable baseline and split-suite wall times, plus the four test-file durations.
- Log: 20261021111245-b82645
- Why skipped: labelled GAP by the reviewer; harm: The requested performance improvement remains unverified.

## G32 · open · 2026-10-21 · LOW
- Task: Fix three issues found in the MQL5 chat: notes edits voiding reviews, CLAUDE.md reverts, risk spreading to docs
- Where: -
- Problem: F1: R2 adds two regression tests instead of one
- Trigger: The suite registers both new R2 regressions at tests/install.test.js:288 and tests/install.test.js:305.
- Fix: Combine the save-during-write scenario into the existing imported-CLAUDE.md regression and remove the second test registration.
- Log: 20261021145050-f942d6
- Why skipped: pair: confirmed by B

## G33 · open · 2026-10-21 · LOW
- Task: -
- Where: install.js:224
- Problem: A CLAUDE.md without crosscheck's import line is replaced from personal.md; a save that adds that exact import line between install's read and its write would be overwritten (CodeRabbit on PR 17).
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: Can't realistically happen: only install writes crosscheck's import line, and its read and write of CLAUDE.md run under the same config lock, so a second install sees the line and leaves the file alone; personal edits go to an imported CLAUDE.md, which install never writes. A file without the line is replaced by design, and the confirmation shows the new text.
