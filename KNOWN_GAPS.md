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

## G34 · open · 2026-10-23 · LOW
- Task: -
- Where: tests/cli.test.js:107
- Problem: Under the full suite's parallel load, the test 'an unavailable pair hands its bundle to the fallback...' fails now and then: review --fallback exits 1 with empty stdout (seen twice in about eight full runs on 2026-10-23; it passes alone, 6 of 6). The cause isn't known yet: it could be the test's timing or a real failure of the fallback path under load.
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: Not caused by the commit-guard change (that test never reaches it); finding the cause needs the CLI's stderr from a failing loaded run, so it gets its own look rather than holding up the guard fix.

## G35 · open · 2026-10-23 · LOW
- Task: -
- Where: src/hook.js:128
- Problem: For PowerShell's git -C, the guard always expands an unquoted ~ to the profile folder; where PowerShell's native-command tilde expansion is off (Windows PowerShell 5.1, or the feature disabled), PowerShell passes ~/repo literally (CodeRabbit on PR 20).
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: Doesn't apply here: Claude Code's PowerShell tool runs PowerShell 7.6.6 on this PC, which expands an unquoted ~ for native commands (measured: ~/x became C:\Users\<user>/x), and a wrong pick would also need a repository inside a folder literally named ~; detecting PowerShell's feature state would be machinery for that.

## G36 · open · 2026-10-23 · LOW
- Task: -
- Where: src/hook.js:116
- Problem: The guard unquotes a PowerShell single-quoted folder by dropping every quote, so a doubled apostrophe ('C:/O''Brien/repo', PowerShell's O'Brien) becomes OBrien and names no repository; Set-Location -Path also expands wildcards ([ ] * ?), which the guard reads literally (GPT's idea check on the Set-Location change).
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: An existing limitation of the quote reading, not made realistic by reading Set-Location: no project path here has an apostrophe or a wildcard character, and the guard is a backstop against slipping, not a shell parser.

## G37 · fixed · 2026-10-23 · LOW
- Task: Fewer useless tests: test plans and bug fixes ask only for tests that protect something
- Where: src/hook.js:257
- Problem: F1: Stop reminder omits the harmless unmet-requirement exception
- Trigger: A harmless unmet requirement becomes an automatic BUG through findingsOf(), then the Stop hook runs.
- Fix: Add that a BUG recording only an unmet requirement needs a test only when money, data or security depends on it.
- Log: 20261023192146-f048fa
- Why skipped: pair: both

## G38 · open · 2026-10-23 · LOW
- Task: -
- Where: tests/screen.test.js:129
- Problem: Under the full suite's parallel load, 'a worker started late by a helper keeps the desktop after its driver and its helper are gone' failed once (2026-10-23): the next computer run was refused because GPT's earlier run still held the desktop. It passes alone (3 of 3) and in the full runs before and after.
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: Not caused by the test-plan change (it touches no screen code); like G34, finding the cause needs a failing loaded run's details, so it gets its own look rather than holding up this change.

## G39 · fixed · 2026-10-24 · LOW
- Task: Fixes from the 2026-10-24 review of the chats: gap bookkeeping, split-review advice, commit refusal text, CLI words, open chains
- Where: src/hook.js:173-174
- Problem: F2: Include the pre-command explanation in BUG-only refusals
- Trigger: All changed files are acknowledged, but an open BUG blocks a shell command containing close or follow-up followed by git commit.
- Fix: Append the pre-command explanation once to every commit refusal, outside the conditional branches.
- Log: 20261024234410-f7801d
- Why skipped: pair: both

## G40 · fixed · 2026-10-24 · LOW
- Task: Fixes from the 2026-10-24 review of the chats: gap bookkeeping, split-review advice, commit refusal text, CLI words, open chains
- Where: DESIGN.md:162
- Problem: F3: Remove the contradictory description of gap commands
- Trigger: A reader consults the detailed KNOWN_GAPS.md behavior after using gap --add or gap --fixed.
- Fix: Include gap-command writes in the automatically acknowledged bookkeeping description and reserve the hand-change rule for edits.
- Log: 20261024234410-f7801d
- Why skipped: pair: confirmed by B

## G41 · open · 2026-10-25 · LOW
- Task: -
- Where: src/review.js:320
- Problem: When KNOWN_GAPS.md can't be read, gaps.openFor returns no entries, so a review's prompt simply has no Known gaps section (CodeRabbit on PR 24).
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: The only effect is the old behavior: GPT may report a recorded gap again. A review that has gaps to write already refuses to apply while the file can't be read, so the problem surfaces.

## G42 · fixed · 2026-10-25 · MEDIUM
- Task: Fixes from the 2026-10-25 review of the chats: known gaps in reviews, staging with a commit, BOM input, findings first, rate limits
- Where: tests/hook.test.js:138-167
- Problem: F4: T1's planned Git-option regression was removed
- Trigger: The supplied T1 plan is checked against its named regression test.
- Fix: Restore T1's exact command to the existing staging table and retain both acknowledgement assertions.
- Log: 20261025184329-5f555d
- Why skipped: pair: confirmed by A

## G43 · open · 2026-10-25 · LOW
- Task: -
- Where: src/hook.js:170
- Problem: A git hook that runs during the commit (the repository's pre-commit hook, or one a -c core.hooksPath setting names) could stage files after the commit guard checked, so they would go in unchecked (noted by the reviewers of PR 24).
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: Hooks are code configured on purpose, outside the command line the guard reads; the guard is a backstop against Claude slipping, and none of the user's repositories has a hook that stages files.

## G44 · fixed · 2026-10-25 · LOW
- Task: -
- Where: src/review.js:322
- Problem: The project's lessons go into the review prompt without a fence or a 'recorded text, not instructions' label, unlike the known gaps (CodeRabbit on PR 24).
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: Older than this change, and the lessons hold only lines Claude records itself with crosscheck's lesson command; it gets its own look rather than widening this pull request.

## G45 · fixed · 2026-10-26 · LOW
- Task: Fixes from the 2026-10-26 review of the chats: status as a commit preflight, busy files left out, test plan first
- Where: src/review.js:625-639
- Problem: F3: Failed reviews omit the held-file notice
- Trigger: A fresh review leaves out a busy session file, then GPT is unavailable, the pair fails, or application is refused.
- Fix: Append the held-file notice to every post-admission result.
- Log: 20261026224654-125d0e
- Why skipped: pair: both

## G46 · open · 2026-10-26 · LOW
- Task: Fixes from the 2026-10-26 review of the chats: status as a commit preflight, busy files left out, test plan first
- Where: tests/review.test.js:342-347
- Problem: F4: T3 does not observe reservation publication
- Trigger: Run the regression test intended to verify refusal before any reservation is published.
- Fix: Observe project-state writes during each refused request and assert that none publishes a reservation for the selected files.
- Log: 20261026224654-125d0e
- Why skipped: pair: both

## G47 · open · 2026-10-26 · MEDIUM
- Task: -
- Where: src/review.js:823
- Problem: A modified git submodule is reported by git status as a folder, which versionOf can't read, so unreviewedForCommit throws: status stops with an error and the commit guard fails open (logged in hooks.log, shown by status) for that commit (CodeRabbit on PR 25).
- Trigger: A project with a git submodule whose recorded commit changed.
- Fix: -
- Log: recorded by hand
- Why skipped: No project crosscheck runs in has a submodule (checked 2026-10-26), and the guard's throw predates this change; fix it when a project adds one.

## G48 · open · 2026-10-26 · LOW
- Task: -
- Where: src/review.js:187
- Problem: If the task's Requirements change in the moment between admission and freezing, the review runs with a plan that is no longer current and can't acknowledge the risky file (CodeRabbit on PR 25).
- Trigger: Another process rewrites the task's Requirements during the few milliseconds between admit and freeze.
- Fix: -
- Log: recorded by hand
- Why skipped: Only Claude edits the task file, one command at a time, so the window isn't reachable in normal use; the result fails safe (nothing is acknowledged, the summary says why).

## G49 · fixed · 2026-10-27 · LOW
- Task: The MQL5 docs server is mql5-docs now: record it again and give it to GPT
- Where: install.js:108-115
- Problem: F2: The permitted env name __proto__ is silently discarded
- Trigger: The env table contains __proto__ = 'value', which passes the plain-variable-name check.
- Fix: Create the env dictionary with Object.create(null).
- Log: 20261027011942-a78d3d
- Why skipped: pair: both

## G50 · fixed · 2026-10-27 · LOW
- Task: The MQL5 docs server is mql5-docs now: record it again and give it to GPT
- Where: DESIGN.md:188
- Problem: F3: The design omits pre-approval and optional startup
- Trigger: A reader consults the docs-server description for the behavior required by R2.
- Fix: Add those two guarantees to the paragraph.
- Log: 20261027011942-a78d3d
- Why skipped: pair: both

## G51 · open · 2026-10-27 · LOW
- Task: -
- Where: src/codex.js:27
- Problem: tomlString uses JSON.stringify, which leaves U+007F (DEL) unescaped though TOML basic strings must escape it, so a docs setting holding that character would make the run's -c setting invalid and the run fail (CodeRabbit on PR 26).
- Trigger: A docs server command, arg or env value containing the DEL control character.
- Fix: -
- Log: recorded by hand
- Why skipped: No path or setting of the docs server holds a control character in normal use; the run fails visibly rather than doing anything unchecked.

## G52 · open · 2026-10-27 · MEDIUM
- Task: The MQL5 docs server is looked up at each MQL5 job, so its updates can't break it; digests get it too
- Where: src/review.js:397-404
- Problem: F1: Repairs and cross-checks receive docs without the promised prompt note
- Trigger: An MQL5 review produces findings requiring cross-checks, or an answer requires repair.
- Fix: Ensure each outgoing prompt includes DOCS_NOTE when docs is passed, including cross-checks and repairs. Extend T2 to assert this relationship on every recorded request.
- Log: 20261027104530-8d5d4e
- Why skipped: pair: both

## G53 · open · 2026-10-27 · MEDIUM
- Task: The MQL5 docs server is looked up at each MQL5 job, so its updates can't break it; digests get it too
- Where: src/review.js:117
- Problem: F2: Test plans omit docs when MQL5 appears only in context files
- Trigger: Run testplan with a non-MQL5 target and an existing MQL5 context file, for example --files tests/risk.test.js --context src/Risk.mqh.
- Fix: Have testplan include context paths alongside target paths when calling docsFor().
- Log: 20261027104530-8d5d4e
- Why skipped: pair: both

## G54 · open · 2026-10-29 · LOW
- Task: -
- Where: tests/screen.test.js:78, tests/screen.test.js:102
- Problem: Two screen tests fail now and then in the full suite: on 2026-10-29 'a worker started late by a helper keeps the desktop after its driver and its helper are gone' failed once and 'a GPT worker that outlives its killed driver keeps the desktop until it ends' once, in 2 of 3 full runs. Each time allow-screen was still refused after the test had killed every process it knew of; both passed 3 of 3 run alone. Likely causes, not proven: under load Windows gave a finished process's id to a new process, and state.mayRun counts any live process with that id; or (the second test) the run noted one more process after the test copied the desktop record's list, so the test never killed it.
- Trigger: -
- Fix: -
- Log: recorded by hand
- Why skipped: A timing flake in a test; the gate errs toward keeping the desktop held, never toward two operators on one screen. When it fails, rerun it alone before treating it as a regression.

## G55 · fixed · 2026-10-30 · HIGH
- Task: Muse Wonder Full as a second reviewer, behind a switch
- Where: tests/muse.test.js:37
- Problem: F1: T1 cannot detect removal of privacy safeguards
- Trigger: The contributor-mode override is removed from READ_ONLY while the user's Muse setting enables contributor mode.
- Fix: Assert the required launch flags against independent literal expectations, including '--contributor-mode off', for both preflight and model calls. — test: Remove the contributor-mode override and confirm T1 fails; restore it and confirm T1 passes.
- Log: 20261030122925-565033
- Why skipped: pair: both

## G56 · fixed · 2026-10-30 · MEDIUM
- Task: Muse Wonder Full as a second reviewer, behind a switch
- Where: src/muse.js:219-236
- Problem: F2: Live probes bypass Muse's cooldown
- Trigger: Run doctor --live during an active Muse cooldown, or have its Muse probe encounter a usage or login failure.
- Fix: Check Muse's cooldown before probing and record a Muse-only cooldown when the probe reports a usage or login failure.
- Log: 20261030122925-565033
- Why skipped: pair: both

## G57 · fixed · 2026-10-30 · MEDIUM
- Task: Muse Wonder Full as a second reviewer, behind a switch
- Where: src/muse.js:148
- Problem: F3: Nonzero exits hide Muse's reported failure reason
- Trigger: Muse emits a terminal failure explaining a login or usage problem and exits with code 1, as the supplied stub does.
- Fix: Preserve timeout and watchdog reasons, but prefer the terminal failure reason over a generic nonzero-exit message.
- Log: 20261030122925-565033
- Why skipped: pair: both

## G58 · fixed · 2026-10-30 · LOW
- Task: Muse Wonder Full as a second reviewer, behind a switch
- Where: src/muse.js:248
- Problem: F4: Doctor omits installation and version information while Muse is off
- Trigger: Run doctor with the default Muse switch state, or after muse off.
- Fix: Include installation and version information in doctor's Muse check regardless of the switch, while keeping model probes conditional on the switch.
- Log: 20261030122925-565033
- Why skipped: pair: both

## G59 · fixed · 2026-10-30 · LOW
- Task: Muse Wonder Full as a second reviewer, behind a switch
- Where: src/review.js:735-740
- Problem: F3: G45 now also suppresses Muse's required fallback disclosure
- Trigger: Muse fails, the GPT fallback succeeds, and applying the answer is refused because the state lock is busy or required state cannot be read.
- Fix: Append note to applyAndSummarize's refusal text.
- Log: 20261030125102-78deb1
- Why skipped: pair: both

## G60 · fixed · 2026-10-30 · LOW
- Task: A sounder cross-check merge
- Where: src/review.js:365-370
- Problem: F2: Whole-shown tests can still be duplicated through test plans
- Trigger: A reviewed test file is shown whole, such as a new test or a review using --full, and a current plan names that test.
- Fix: After collecting all copies, exclude snapshots whose hashes were already shown whole in the reviewed-file material.
- Log: 20261030152729-5108f4
- Why skipped: pair: both

## G61 · fixed · 2026-10-30 · MEDIUM
- Task: Faster and leaner crosscheck, Muse in risky plan reviews
- Where: src/modes.js:100
- Problem: F1: Muse silently misses named files containing spaces or lacking extensions
- Trigger: A risky plan names an existing project file such as `src/payments v2.js` or `scripts/migrate` while Muse is enabled.
- Fix: Match the plan's references against git-listed project paths, including paths with spaces and without extensions, before applying the existing containment check.
- Log: 20261030170845-23652d
- Why skipped: pair: both

## G62 · fixed · 2026-10-30 · LOW
- Task: Faster and leaner crosscheck, Muse in risky plan reviews
- Where: src/review.js:749
- Problem: F2: Replacement GPT B loses its retry when A is reused
- Trigger: Muse's first review fails, A completed successfully, and the replacement GPT B returns invalid answers through its repair while GPT remains available.
- Fix: Remove `firstA` from the early-return condition. The second direct `pair.runPair` call already limits B to one additional attempt.
- Log: 20261030170845-23652d
- Why skipped: pair: confirmed by B

## G63 · open · 2026-10-30 · LOW
- Task: Faster and leaner crosscheck, Muse in risky plan reviews
- Where: tests/modes.test.js:487-505
- Problem: F3: T2 does not observe external credentials reads
- Trigger: The plan reader regresses to reading the external credentials fixture but discards its contents before saving or sending them.
- Fix: Instrument reads in the process executing `modes.plan` and assert that the external fixture is never read, retaining the existing outgoing-material assertions.
- Log: 20261030170845-23652d
- Why skipped: pair: confirmed by B

## G64 · fixed · 2026-10-30 · MEDIUM
- Task: Muse asks for the files it needs; two isolation fixes
- Where: src/review.js:597-598
- Problem: F2: Cancelling the files round loses its bundle record
- Trigger: The user cancels crosscheck while Muse is answering the files round.
- Fix: Save the files-round prompt before calling muse.ask, then update that turn with the answer or failure when the call returns.
- Log: 20261030185118-c80437
- Why skipped: pair: confirmed by B

## G65 · open · 2026-10-30 · MEDIUM
- Task: Muse asks for the files it needs; two isolation fixes
- Where: -
- Problem: F3: R7 is PARTIAL
- Trigger: the task as asked
- Fix: -
- Log: 20261030203424-0e2402
- Why skipped: no code is left unmet: R7's remaining part is the PR work itself (the reply on PR 31's CodeRabbit thread once this is pushed, and PR 32's own CodeRabbit round, which was rate-limited and is asked for again next)

## G66 · open · 2026-10-30 · MEDIUM
- Task: Muse asks for the files it needs; two isolation fixes
- Where: src/modes.js:208
- Problem: F1: UNCLEAR: risky-plan Muse prompt drops the project file list
- Trigger: A risky plan is reviewed with Muse enabled, and Muse needs a project file that the plan does not name.
- Fix: Restore the project list in the risky-plan musePrompt unless withMuse is shown to add it exactly once and prompt-muse.md records what was actually sent. — test: Existing or new risky-plan integration test: with Muse enabled, assert the actual Muse prompt or prompt-muse.md contains the capped project-file list and that requesting an admitted listed file produces the second answer.
- Log: 20261030192654-c32ed8
- Why skipped: can't happen where the fix landed: on branch muse-files (PR 32) src/modes.js builds Muse's plan prompt with review.projectList(root) and passes planPath to withMuse, confirmed by the completed pair of chain C20261030201646-5128c6; this review had compared PR 31's branch, which never had them, against PR 32's version

## G67 · open · 2026-10-30 · MEDIUM
- Task: Muse asks for the files it needs; two isolation fixes
- Where: -
- Problem: F2: R7 is PARTIAL
- Trigger: the task as asked
- Fix: -
- Log: 20261030192654-c32ed8
- Why skipped: no code is left unmet: R7's remaining part is the PR work itself (the PR 31 reply and PR 32's CodeRabbit round), as closed in chain C20261030201646-5128c6
