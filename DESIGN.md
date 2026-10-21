# crosscheck, the coding driver: design (v9, built)

The coding driver replaces today's Claude + GPT setup with a full rewrite. It is the daily driver for all of the user's code: Claude writes the code, GPT checks it, and the driver keeps that loop honest with as little friction and as little code as possible.

Status: built in the steps of section 16 (pull requests 1 to 10) and installed on 2026-10-20, replacing the old setup, which was retired the same day (section 11); its repository stays as it is. The code lives in this repository, `shamwi2846/crosscheck-review`.

## 1. Principles (they apply to the driver's own code and to every project it drives)

1. **Simple, easy-to-follow code, everywhere.** Write the simplest solution that does what was asked, so a reader can follow it right away: clear names, small functions, straight flow, no clever tricks, comments only to explain why. Use faster or more complex code only for a measured need (a proven slow loop or query), with a comment saying why. Simplify existing code when you are already changing it, never as a separate rewrite.
2. **Nothing that isn't needed.** No extra options, switches, layers or just-in-case code. This also covers fixes that GPT or CodeRabbit suggest. No new library unless it saves real code or real risk; prefer what the language already has, since every added library is code you don't control. "Simplest", not "fewest lines": cramming code to save lines makes it worse.
3. **Removing is improving:** dead code, unused features, and handling of cases whose worst outcome is harmless. First check why the code is there. A removal is reviewed like any change, and removing a safety check from risky code is a risky change.
4. **Rare cases are judged by harm, not by how rare they are.** Keep protection against rare cases that could lose money, lose data or open a security hole (a restart mid-trade, a partial fill, a duplicate order, an order without a stop loss). A simpler check that still protects is fine. Safety checks (input validation, error handling, security checks, guards against data loss) are not complexity to trim. Secrets (keys, passwords, tokens) never go into code or commits; every review checks for them.
5. **Quality means fixing real bugs** that could happen in normal use, not covering every edge case. Effort goes where money, data or security is at stake. An expensive fix never turns a real bug into a gap: look for a simpler fix.
6. **Push back first.** If a request seems harmful or not worth it, Claude explains why briefly, recommends an alternative and waits for the user's choice. This overrides "don't ask" and "never block" for that one decision. Claude makes routine choices itself, and doesn't reopen an objection the user has already weighed.
7. **Fast.** Hooks run on every tool call, so they do almost nothing: no git calls and no scans on edits, one small state file. GPT runs in the background, and follow-ups resume GPT's session.
8. **Fail open, except for safety.** A hook that crashes never blocks the user's work, except the desktop gate (who controls the screen) and the GPT lockdown, which fail closed.

## 2. The workflow it supports

1. **Task.** For a non-trivial request, Claude writes `task.md`: numbered requirements in its own words, with constraints and exclusions. The user's exact words go in a separate local `words.md`, which is never sent to GPT. Claude updates `task.md` only when the user's request changes, never to make a check pass. There is no per-message ceremony. Each session has its own task file, so two sessions in one project never share one. The driver identifies a task by its id and the hash of its Requirements section only: plans, skips and reviews are bound to that hash, so a changed request makes them stale (pre-edit asks again, and a plan gets extended), while edits to the Notes section don't. A running review is stricter: any change to the task file while it runs acknowledges nothing, and the review runs again. Decisions, progress and open items go in Notes, so nothing is lost when the chat is shortened.
2. **Sort each change** by what it does, in any kind of project: no behavior change, normal, or risky. Risky means money and payments, deleting or migrating data, security (logins, permissions, secrets), anything that can't be undone, and in trading code orders, lots, SL/TP, risk, EA inputs and `.set` presets, plus code that risky code uses. Unsure means risky. Order, lot and SL/TP changes are always risky.
3. **Risky: test plan first.** `crosscheck testplan` gets at most 5 cases from GPT (the main path plus the realistic ways to lose money or data), and Claude writes them as tests. A file that isn't risky gets `crosscheck skip --why "..."` instead.
4. **Code.** Claude reads the code it edits itself. Before changing what a function takes, returns or does, it greps the callers, and it fixes a bug once in the shared code rather than in the one caller that showed it. It splits big work into steps of about 300 changed lines or less; each step gets its GPT review and is committed locally, and the whole job is pushed as one pull request once every step is done, so CI and CodeRabbit run once per job. It edits with Edit/Write, so the driver sees every change. Steps that depend on a pending GPT result (installs, migrations, releases, trade setup) wait for it, while independent work goes on. Every project the driver works on is a git repository (a one-time `git init`), so a file deleted or moved by a shell command still has its original in git; at session start the driver points out a folder that isn't one, since it tracks no change made there. Tests stay as few as possible: only where a bug could cost money, lose data or break security, plus one regression test for each real bug fixed. Claude runs the affected tests (and compiles) while working, runs the full suite on the final code, and attaches that output to the review. Risky changes need a passing run on the final code.
5. **One review at the end.**
   - **Normal changes:** one GPT at high effort reads the diff with context.
   - **Risky changes:** two GPTs at xhigh read the whole files and the code that calls them.
   - **Comments, formatting or docs only:** a task that touches nothing else may skip GPT, with a recorded reason (`review --skip --why`). Renames and anything else still get reviewed, and the skip is refused for risky files.

   Findings are BUG (it can really happen and cause real harm) or GAP (everything else, recorded in `KNOWN_GAPS.md`).
6. **Follow-ups** check only the open findings and the changed lines. There are at most 3 rounds in total. After that, Claude fixes the remaining bugs, and later rounds look only at the fixed lines, for every kind of change, so nothing ends up unreviewed. A BUG is closed only as fixed (verified) or relabelled a GAP with a reason (in risky code, a one-line proof that it can't happen). Reaching the round limit never relabels anything, and a BUG that is neither fixed nor relabelled keeps the task unfinished.
7. **Finish.** Claude verifies every finding itself, and fixes every BUG with one regression test. When it is unsure in trading or money code it fixes; elsewhere it records a gap. Nothing ends with an open BUG or anything unreviewed. Claude tells the user briefly what GPT found and what was fixed or left as a gap. Then it commits or opens a pull request.

## 3. Size budget (a ceiling, not a target)

| File | Job | Budget |
|---|---|---|
| `crosscheck.js` | the CLI: parse arguments, dispatch commands, print results | 250 lines |
| `hook.js` | every Claude Code hook | 200 |
| `codex.js` | run Codex: arguments, isolation, lockdown, timeouts, process tree, usage limits | 250 |
| `review.js` | review material, prompts, recording, follow-ups, rounds | 350 |
| `pair.js` | two reviewers, the cross-check, the merge | 150 |
| `answer.js` | read GPT's JSON answer and check it against a small schema and its meaning | 150 |
| `state.js` | per-project and global state: atomic writes, one lock each, one transaction per review result | 120 |
| `gaps.js` | `KNOWN_GAPS.md` and lessons | 80 |
| `install.js` | install, register hooks | 120 |
| tests | only the paths that protect real harm (section 12) | 700 |

Total: about 1,670 lines of code, install included, and 700 of tests, against about 7,900 and 7,600 today. These are ceilings, not targets: Fable's estimate for this scope is 1,200 to 1,500. Going over a budget needs a reason written into this file.

Built, the code is about 3,110 lines, install included, and the tests about 3,200. Each overrun is recorded below.

Recorded overruns:
- `state.js`, about 230 lines: lock ownership. A lock names its owner process and is reclaimed only once that process has ended, under a serialized reclaim guard. A write happens only while the lock is still held. Step 1's review found that age-based reclaim lets a stalled holder and a new holder overwrite each other. Steps 4 to 6 added finding a project without git (the hooks run on every edit), the desktop owner's process check, and the state folder of the Claude Code profile it serves.
- `answer.js`, about 175 lines: the answer shapes of GPT's other jobs (step 5b), and the test plan's checks: each case names an existing requirement, covers a listed target and names a test inside the project.
- `codex.js`, about 375 lines:
  - Process cleanup on Windows. Codex's launcher runs the native `codex.exe`, and what Codex starts hangs off that process, outside every job object. So the run notes its processes at the first output and stops everything descended from them, even after they exit. A computer run notes them again every 2 seconds, so what a helper started later stays the run's after that helper exits (the final audit found that a late helper's worker could outlive the run and its desktop record). Step 1's review found that killing only the launcher's tree left those processes running and could hang the run.
  - Reading Codex's `--json` events. Its plain output repeats the prompt and GPT's text, which falsely triggered the usage cooldown (found in PR 1).
- `gaps.js`, about 165 lines: compatibility and privacy, plus the plain reads the hooks use (a file's open gaps, the lessons as read), added in step 4.
  - Projects already hold `KNOWN_GAPS.md` files that the old setup wrote, some with Windows line endings. New entries are appended so that every existing byte stays, and a status change rewrites only that entry's header.
  - The project and home folders and e-mail addresses are taken out of every field, because the file is committed to public repositories.
  - A file that can't be read is never taken as empty.
- `review.js`, about 725 lines. The final audit's fixes added the paired-review condition for risky files, the follow-up's session check and crosscheck's own gap entries counting as reviewed. Steps 4 and 5 added the queries the hooks use, the review skip, and the runner options GPT's other jobs share. Step 3 added the risky material (whole files, frozen candidate callers, frozen plan tests) and the test-plan check before a risky file is acknowledged. Before that, it held what the three plan-review rounds of step 2b required, so that only reviewed versions are ever acknowledged:
  - choosing and reserving the files in one state transaction, with dead reservations reclaimed;
  - a bundle per attempt (frozen copies, prompt, manifest), so the fallback reviewer judges the same material and an answer applies only once;
  - chain revisions, so a stale follow-up, close or fallback changes nothing;
  - change generations, so an edit made during a review stays pending;
  - baselines from the last reviewed version or from git for shell changes and deletions;
  - each round's turns saved, so a fresh GPT session can continue a chain;
  - gap entries written under the state lock.
- `hook.js`, about 330 lines. Steps 5 and 6 added binding a plan's review to its task, and the hook list and hook-command matcher that install.js and doctor.js share. Step 4's plan review asked for these, and each guards a real harm:
  - the screen gate validates the desktop record and treats a process it can't check as running, so a bad record never unlocks the desktop;
  - returned failures (a state that can't be read, a lock taken over, an unreadable gaps or lessons file) are logged, not only thrown errors;
  - the commit guard finds its repository from `-C` or a leading `cd`, and checks both paths of a rename;
  - bundle cleanup runs under the project lock and keeps open chains' rounds and reserved attempts.

  The refusal texts name the exact next command, so Claude doesn't have to guess.
- `crosscheck.js` and a new `modes.js`, about 275 and 270 lines. GPT's other jobs (test plans and skips, plan reviews, ideas, digests, research, writing, screen control) live in `modes.js`, since the CLI's 250 lines can't also hold them.
  - Screen control records every Codex process a computer run starts, as it is noted, so the desktop stays owned while any of them runs, even after its driver is killed.
  - The CLI checks each command's options. A typo or a missing value is wrong usage, never a silently different run, because a review skip bypasses GPT.
  - The jobs reuse review.js's runner, so their isolation, schema, repair and bundles are a review's.
- `install.js`, about 245 lines (about 340 until the old setup's retirement removed restore, its backup and the old setup's checks). Step 6a's plan and code reviews required each of these, because the installer rewrites the user's global Claude Code setup:
  - writing settings.json last, and putting back everything written (the code included) when a step fails, by moving each original aside first, so a full disk can't stop the rollback;
  - reading the MQL5 docs server from the Codex config only in its plain form, single-quoted strings included;
  - matching only the hook commands that run crosscheck's hook;
  - refusing while a review runs or a project's state can't be read, both before asking and after.
- A new `doctor.js`, about 205 lines: the CLI couldn't hold the checks. It shares with install.js the hook list (in hook.js) and the Claude Code lookup, which tries again without the saved command when that fails (Node moved, say).
  - Its live probe asks GPT to really try a write and to answer in a plain sentence, so only an enforced schema yields JSON.
  - A proven write takes away the verified version, and the version is pinned before the probes and checked after.
- Tests, about 2,900 lines: the review and pair paths above are each covered by the at most five cases of their test plan, and those cases need real processes and git projects. Steps 4 to 6 added the tests of the hooks, the CLI, GPT's other jobs, screen control, install and doctor, each from its plan's cases.

## 4. Commands

- `review [--files a,b] [--risky] [--full] [--evidence-file out.log]`: the task's one review. Without `--files`, it covers this session's pending changes. Other sessions' changes are reviewed only when named explicitly, and a follow-up is refused while another session has a pending change in one of its chain's files. Shell-made changes are added with `--files`, and the commit guard catches anything left out. Big reviews can be split into parallel runs over different files. A relative path is looked up from the project's root. A path that matches nothing, or matches two different files, is refused before GPT is asked, unless it is a deletion git knows about. A whole-file audit of unchanged code is `review --full` (this happens automatically when nothing changed), not `digest`.
- `review --skip --why "..."`: only for a task that touches nothing but comments, formatting or docs (refused for risky files); the reason is recorded.
- `review --followup <chain> --file response.md`: the next round of a chain.
- `close <chain> --note "F1: gap: <why>; F2: gap: <why>"`: closes a chain. Every open BUG needs a reason: a fix counts once a follow-up resolved it, so a note is only for a BUG left unfixed.
- `testplan --files a,b` (the cases are drawn from the session's `task.md`) and `skip --files a --why "..."`. A case that names a requirement id the task doesn't have, or no target file, is refused (one repair).
- `plan --file plan.md [--risky]`: required before leaving plan mode; `plan --skip --why "..."` for a plan too small to matter.
- `idea --file draft.md`: only for advice on risky or hard-to-undo decisions.
- `digest --files ...|--dir ... --question "..."`: big logs, tester reports, unfamiliar code. The answer has a fixed shape:
  - the answer;
  - evidence, as path:line with the exact quote;
  - counts: passed, failed, and the first failure;
  - scope: what was read, and any truncation;
  - confidence: proven or a hypothesis.
- `research --question "..."`: web lookups, the only mode with web access.
- `write --brief brief.md`: GPT returns a long document's text, the driver saves it as a staged draft, and Claude reads it and applies what is right with Edit. This is never used for code, config or agent files: those are Claude's own.
- `computer --task "..."`: screen control, look and act, never retried.
- `gap [list | <id> --fixed [--real-bug] | --add ...]`.
- `lesson --text "..."`: adds a confirmed past mistake to the project's lessons, which every session start prints.
- `status`: pending changes, open BUGs and open chains, in a few lines.
- `on` / `off`: the switch, used only when the user asks.
- `allow-screen --why "..."`: a 30-minute window for Claude's own screen tools (section 9).
- `doctor [--live]`: checks that Codex is found, the hooks are registered and the state can be read. `--live` also makes harmless real Codex calls: a read-only run that tries to write a file and must fail, the same check through a resumed session, and the computer lockdown listing (no screen action). It records the Codex version it verified, and warns when Codex has changed since. It runs after install and Codex updates.

Dropped commands (section 13): `task`, `done`, `score`, `run`, `triage`, `stats`, `mql5-compile`, `apply`/`discard`, `mark-reviewed`'s release modes. `allow-claude-cu` becomes the simpler `allow-screen`.

## 5. Hooks

| Hook | What it does | On failure |
|---|---|---|
| SessionStart | Prints the project's lessons, the on/off state, one line of pending work, and a note when the folder isn't a git repository | open |
| PreToolUse Edit/Write/MultiEdit/NotebookEdit | Saves the file's baseline (its content before its first edit since the last review) before the edit happens, because a Write destroys it, and marks the file as changed by this session; then the risk gate (section 6). On the first edit of a file in a session, it also shows that file's open gaps (a plain line scan of `KNOWN_GAPS.md` for the path, nothing more), which Claude fixes only when the change makes them realistic. An edit that then fails only adds an unchanged file to the review, which costs nothing, so no second hook after the edit is needed | open: a file whose original couldn't be saved is reviewed whole |
| PreToolUse Bash/PowerShell | Commit guard: on `git commit` only, one `git status --porcelain` call. The commit is refused if any modified, added or deleted file's current content differs from its last acknowledged reviewed copy (no acknowledgement means unreviewed), so shell-made changes are caught too, or if a BUG is open. It's a backstop against Claude slipping, not a lock against someone determined to get past it, so it doesn't parse commit flags or compare staged blobs | open |
| PreToolUse ExitPlanMode | Requires that the plan being presented was reviewed or skipped with a reason (`plan --skip --why`, for a plan too small to matter). The comparison is by hash after whitespace is normalized, so a trailing newline never refuses an exit. The hook uses the plan text from its input, or else the plan file the input names; when neither is there, it allows the exit with a warning | open |
| PreToolUse computer-use tools | Desktop gate: one operator at a time; Claude's own screen tools only inside a 30-minute window opened by `allow-screen` (section 9). Fail-closed needs Claude Code 2.1.295 or newer to honor `"onFailure": "block"`; `doctor` checks this, and without it the screen tools are refused | **closed** |
| Stop | Reminds about unreviewed files (never blocks); blocks while BUG findings are open, but only once in a row, since a stop that follows its own block (Claude Code's `stop_hook_active`) passes, so no prompt hook is needed to count turns | open |

Not carried over:
- **The prompt hook.** The rules already say when to consult GPT, and Stop counts its blocks with `stop_hook_active`.
- **The hook after edits.** The hook before the edit records everything.
- **Shell-edit tracking.** Git covers git projects; elsewhere Claude uses Edit/Write or passes `--files`.
- **Cross-project receipts.**

## 6. Risk

- **Any project:** risk is judged by what a change does (section 2): money and payments, deleting or migrating data, security, anything that can't be undone. Claude judges it before editing, and GPT's rating backs it up. The trading-file rule below adds an enforced early check for files that are almost always risky.
- **Trading files:** every edit of a `.mq5`, `.mqh` or `.set` file, new files included, needs a current test plan or a recorded skip for that file in the current task, before the edit. The rule goes by each file's own path; there's no project scan.
- **Unlocking:** a current plan or a recorded skip unlocks that file for the rest of the task, so the gate asks once per file per task, not at every edit.
- **No per-project risk lists yet.** No project needs one so far, and Claude's judgment plus GPT's rating cover other projects. A list of risky globs can be added later, when a real project needs it. There are no ignore globs either: nothing can hide changes.
- **GPT's rating is the backstop.** A normal review also returns a class (`none | normal | risky`), with the files it applies to. A file GPT rates risky is not acknowledged; the review's other files are. That file needs a real plan (a skip no longer counts) and gets a paired review.
- **The review is the last gate.** The pre-edit check enforces "test plan first" for trading files, but lets the edit through if the hook itself breaks. The review refuses to acknowledge a risky file without a plan or skip, and that check fails closed.
- **A file that turns risky during a normal chain** (for example, a fix reaches the order code) gets its own paired review before that chain's follow-up can finish it. The chain stores when it began, and only a risky review recorded after that counts.
- **No word-vocabulary scanner.** It flagged test files as "deleting data" and its own hook as "trading code", which forced a skip on nearly every edit. File types, Claude's judgment and GPT's rating replace it.

## 7. Reviews

- **Material.** The reviewed files and the task file are frozen when the review starts. GPT gets the frozen copies and an exact diff from each file's baseline to its frozen copy, with context lines. Risky files are read whole. Up to 20 project files that mention them come along too; these are candidate callers from a plain name search, labelled as such, and a cut-off is shown in the coverage. Reviewers search further when a finding depends on it, and check every caller of a function whose inputs, result or promise the change alters. Before reporting a finding they confirm its trigger can really happen, and a fix they suggest is the smallest change that works. Test-plan cases and their frozen test files come with the risky files, so reviewers check that the cases were written. The evidence file is labelled stale when it is older than the last change to any reviewed file. Diffs come from `git diff --no-index` on the two snapshot files (UTF-16 files decoded first), so there's no diff library. While a task's reviews run, none of its files is edited, so every reviewer sees the same final versions.
- **Acknowledgement.** Only the frozen version counts as reviewed. A file edited during the review stays pending, checked by comparing its hash at the end. If the task file changed meanwhile, nothing is acknowledged and the review runs again. After a review, the frozen copy becomes the file's new baseline.
- **One review per file at a time.** A review that includes a file already in a running review is refused, so reviews never overlap and their order can't matter. Snapshots are immutable files named by their hash. A review writes them first, then applies its result in one state transaction, so a crash between the two steps leaves only unused snapshot files.
- **Round 1 gets the task and the requirements, never Claude's reasoning,** so GPT judges the code on its own.
- **The requirement list** (`task.md`) goes with every review. GPT rates each requirement (MET, PARTIAL or NOT MET, with evidence), and may suggest a requirement the work clearly needs (`possibly_missing`), which Claude decides on. A NOT MET or PARTIAL row is a finding like any other. A follow-up after a requirements change gets the changed requirements and checks them again.
- **Every confirmed finding is reported,** with no cap. The coverage line says honestly what was checked, what doesn't apply (`n/a`) and what wasn't examined.
- **The project's lessons** go into every review prompt, as well as being printed at session start.
- **The answer is JSON in a fixed shape**: verdict, findings, requirement rows, class and coverage. Codex enforces the shape itself (`--output-schema`, for fresh and resumed runs alike), so the driver only checks the meaning: every requirement id appears exactly once; in a follow-up, every open finding id appears exactly once and no unknown id does; a clean verdict never sits next to a finding or a maintained BUG. If a check fails, GPT gets one repair in the same session, and after that the run counts as not done. No Markdown is parsed, and no model text is ever rewritten. Each finding has: severity, title, location, trigger, harm, failure, fix, test (for high severity) and label (BUG or GAP), plus `reqs` (the requirement ids it shows unmet).
- **The driver shows Claude a short readable rendering**, and logs the full prompt and answer.
- **Chains** live in state: every finding has a stable id (F1, F2, ...), its file and its status. A follow-up lists the open findings by id. GPT answers each one (RESOLVED, MAINTAIN or CONCEDE, with a reason) and may add new findings, but only of MEDIUM severity or above. Lower ones are recorded as gaps. Follow-ups resume GPT's session (fast), with a fresh session if that fails.
- **What a follow-up shows.** Each file's diff since the chain's last round. A file still at the exact snapshot that round froze is named as unchanged, not pasted again: its frozen copy stays listed, and GPT is told to read it whenever a finding, a changed requirement or a caller needs it (the fallback reviewer gets no earlier rounds). Pasting unchanged files again was about 70% of follow-up prompts, and Codex pays for a prompt again on every model call of a resumed session. A changed file with an empty diff (git sees the change as binary) is shown whole.
- **Rounds.** At most 3 full rounds per chain, the first included. After that, rounds look only at the fixed lines, for every kind of change. They report no unrelated findings, but they do report a new bug that a fix itself caused. A rejected fix keeps the task unfinished until its correction passes the same narrow kind of round.
- **Closing a chain** needs one reason per open BUG: either fixed (verified by a follow-up round) or relabelled a GAP with its reason. Hitting the round limit is never a reason, neither in a close note nor in a follow-up's concession (an answer that concedes because of it gets its one repair, like any other wrong answer). Findings closed as fixed are not gaps; relabelled ones go into `KNOWN_GAPS.md` with their reason. The gap entries are written first, and the chain closes after that.
- **`KNOWN_GAPS.md`** is one file at each project's root, written atomically under the project lock. Each entry has an id, a status (open, fixed, or "fixed — was a real bug"), a date, the severity, the task, the place, the problem, the trigger, the fix and the reason it was left. Paths are project-relative, and the home folder and e-mail addresses are removed. Entries are never deleted, only marked fixed. What reviews and closes write there (new GAP entries, entries marked fixed, relabelled BUGs) counts as reviewed when the file was at its last reviewed version with no pending change, so it needs no review of its own; a hand change (`gap --add`, `gap --fixed`, an edit) is reviewed like any other change.
- **Pairs** are only for risky reviews, risky plans and the check before a risky release (for an EA: going live):
  - Reviewer A checks the task; reviewer B attacks the risky parts with one short checklist for every project, skipping what doesn't apply:
    - money and trading: duplicate or missing orders, stop losses, lot and margin limits, symbol specs, magic numbers, broker rejects and requotes, partial fills, a restart mid-trade, stale state, rounding;
    - data: partial runs, no rollback, running twice, integrity, the wrong target, deletion without a guard;
    - security: a check missing on some path, secrets in code, logs or errors, comparisons and expiry, injection, unsafe input;
    - general: errors and timeouts, concurrency and stale state, the interfaces between parts.
  - In the cross-check, which belongs to round 1 and doesn't count as a chain round, each one marks the other's findings CONFIRM, DISPUTE or SAME AS one of its own. A DISPUTE must give concrete evidence that the bug can't happen, and Claude checks that evidence. Nothing else happens in round 2.
  - The merge is deterministic. Agreement and harm are kept apart. A finding found by both, or confirmed, is a BUG unless both reviewers labelled it a GAP (harmless). Disputed means GAP. Unsettled means BUG in risky code.
  - A NOT MET requirement rated by only one reviewer follows that reviewer's linked findings: if all of them were disputed, it is a GAP.
  - If either side fails, nothing is recorded ("PAIR INCOMPLETE"), and the pair runs again. A paired attempt escalates its risky files when it starts, and only a completed pair clears that, so a failed pair, a killed driver or a retry without `--risky` never counts as one.
- **Evidence.** Claude attaches its latest test or build output to a review with `--evidence-file` (optional for trivial changes). GPT is always told that the evidence was supplied by Claude and is unverified, and is stale when it's older than the last change. The driver runs no commands itself.
- **When GPT is unavailable** (after one retry), the output starts with `GPT_UNAVAILABLE` and a short handoff: the risky files, the cases and the checklists. Claude runs the `fallback-reviewer` agent on the failed attempt's frozen bundle. The agent answers in the same JSON as GPT, and Claude records it with `review --fallback <bundle> --answer answer.json`. The driver checks that answer with the same validator and applies it in the same state transaction, findings and follow-ups included. It acknowledges only those frozen versions, with the same risk and scope checks, and only if the files still match them. A risky file the failed pair was to read stays escalated (since that pair started), as a file GPT rated risky is: it stays pending, its chain's single follow-ups leave it out, and only its own completed paired review acknowledges it, so one reviewer never counts as the pair. A trading file escalated this way needs a test plan, not a skip, for its next edit. The fallback agent's definition ships with the repository and is installed with it.

## 8. GPT runs (Codex CLI)

- **Effort:**
  - xhigh: test plans, risky reviews and their follow-ups, risky plan reviews, the check before a risky release;
  - medium: `write`;
  - high: everything else.
- **Isolation for every mode except computer use:**
  - `--ignore-user-config`, a read-only sandbox, and the features `apps`, `plugins`, `multi_agent`, `image_generation`, `tool_suggest`, `computer_use`, `browser_use` and `in_app_browser` switched off;
  - web search off, except in `research`;
  - on MQL5 files only, the read-only MQL5 docs server (mql5-chm), with exactly its read tools. GPT cites the docs topic it checked, or marks an API fact "unverified against the MQL5 docs", for example when the server isn't available;
  - the Windows sandbox runs "unelevated".
- **Computer-use lockdown** (computer runs load the user's Codex config, because the runtime needs it):
  - The driver lists what Codex reports as effective, with `codex plugin list --json`, `codex mcp list --json` and `codex features list`.
  - It keeps only computer-use, unified-computer-use, browser and chrome (`@openai-bundled`), plus the `node_repl` and `cua_repl` servers. Those two count only if their program lives in Codex's own runtime folder, so an unrelated server that happens to use one of those names is refused, not trusted.
  - It switches everything else off for that run: app connectors, account plugins (`features.remote_plugin=false`), sub-agents, image generation, tool suggestions, memories and web search.
  - It lists again, and starts only if exactly that is left. Anything it can't establish refuses the run.
  - The user's own Codex config never changes.
- **Timeouts and cancelling:** 20, 30 and 45 minutes for medium, high and xhigh. A timeout, a cancel, or the driver ending normally kills Codex's whole process tree. Only a forced kill of the driver can leave a worker running. For read-only runs that's harmless. For a computer run, the desktop stays owned until every worker has exited (section 9).
- **`write` stays read-only too:** GPT returns the document's text in its answer, and the driver saves it as a staged draft. GPT never writes files.
- **Usage limits:** a limit or login error starts a 15-minute cooldown and the fallback path. No new GPT runs start during the cooldown. The message "model is not supported when using Codex with a ChatGPT account" means the usage ran out; it is not a bug.
## 9. Computer use

- Claude avoids the screen: files, logs, CLI tools and APIs come first (for MT5: `MQL5/Logs`, the terminal logs, tester reports, exports and `.set`/`.ini` files, read directly). Screen control is delegated to GPT with `crosscheck computer`.
- **One operator at a time across all projects.** One global ownership record, under one global lock, is checked and taken in one step. It names the operator. For a GPT run, that's its driver and Codex worker processes (noted at Codex's first output and every 2 seconds after), and it stays held while either is alive, so a worker that outlives its driver still owns the desktop. For Claude, ownership is the `allow-screen` window itself: 30 minutes, bound to the session id, released when it expires or on `off`. A hook can't tell whether a Claude session is alive, so there's no liveness check, and another Claude session is refused during the window. A second GPT computer run gets BUSY, and Claude's own screen tools are refused while GPT holds the desktop.
- **Claude's own screen tools** are for when delegating is clearly worse, for example an app GPT isn't approved to capture. `allow-screen --why "..."` opens a 30-minute window and records the reason.
- A computer run is never retried, because repeating clicks is unsafe. Files that change during the run are reported (git status before and after).
- Neither model trades, moves money or enters credentials.
- Known limits:
  - In background runs, Codex's own per-app approval refuses screenshots of apps the user hasn't approved in the Codex app.
  - Codex's sub-agent tools stay visible even with `features.multi_agent` off. They run under the same lockdown, and `doctor --live` reports what a computer run can actually reach.

## 10. State and files

```
<repo>/            src/*.js, tests/, RULES.md, agents/fallback-reviewer.md, install.js, README.md
~/.claude/crosscheck/  the installed copy (what the hooks run): code only, replaced by installs
~/.claude/crosscheck-state/   live state, never touched by install
  config.json      the GPT model name and the Codex path (found once, at install), the Codex version doctor verified
  global.json      desktop ownership, the screen window, the on/off switch, the usage cooldown, running GPT jobs
  <project>/       state.json (changes with the session that made them, chains, plans, skips, escalations)
                   tasks/<session>.md and tasks/<session>.words.md (local only)
                   snap/ (immutable snapshots by hash: baselines and frozen copies), logs/
                   lessons.md (confirmed past mistakes, printed at session start)
<project>/KNOWN_GAPS.md
```

- **The shared records in `global.json`** (hooks read them; the CLI writes them, each under the global lock):
  - `off`: true while the user has switched the driver off;
  - `plans`: `{ <hash>: { at, skip? } }`, a reviewed or skipped plan by the hash of its text with every run of whitespace made one space (`planHash` in `hook.js`, shared with the `plan` command);
  - `sessions`: `{ <session id>: { roots, at } }`, the projects a session edited (Stop checks them all);
  - `desktop`: `{ pid, workers, project, at }`, the computer run that owns the desktop: its driver and every Codex worker process it noted, written as they are noted;
  - `screen`: `{ session, until, why }`, Claude's allow-screen window (`until` in milliseconds since 1970);
  - `cooldownUntil`, `cooldownReason`: the usage cooldown.
- **Atomic writes, one lock.** Every state write goes to a temporary file and is renamed into place, under one lock file per project. An unreadable state is never overwritten: the driver reports it and refuses to acknowledge anything.
- **A hook that fails open is never silent.** It writes the error to a hooks log, and `status` and `doctor` show it.
- **Log cleanup.** Logs older than 30 days are deleted, unless they belong to an open chain.
- **A project is its git repository:** its identity and root are the repository's top folder, wherever Claude Code was started inside it.
- **The session** is identified by `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for hooks and for its shell commands. Without it, in the user's own terminal, session-scoped commands refuse unless `--files` names the files.
- **A GPT run whose driver died,** for example when the session closed during a background review, applies nothing. Its running-job record has a dead process, so `status` shows it as not done, and the next start clears it.
- **Paths.** Paths with spaces and non-ASCII letters must work everywhere, because the user's folders have both. Processes are spawned without a shell.

## 11. Install and update

- **Prerequisites:**
  - Node 22 or newer;
  - the Codex CLI, logged in;
  - Claude Code 2.1.295 or newer;
  - git.

  `install.js` checks them all first. It shows what it will change in settings.json and CLAUDE.md, and asks before changing anything. After install, Claude Code is restarted (a new terminal or app session).
- **Install.** `node install.js` runs the tests, copies `src/` and the fallback agent into place, writes `RULES.md`, and registers the hooks in `~/.claude/settings.json`. Registering replaces every hook entry of an earlier driver install and keeps every other hook.
- **Config changes made meanwhile stay.** Right before writing, install reads config.json again under its lock, which it holds until everything is written: a value changed while it asked (a verification doctor took away, a path set by hand) is kept, and an unreadable config.json stops the install with nothing written.
- **Simple order.** Each install waits until no GPT job is running, copies the code, writes RULES.md and CLAUDE.md, and writes settings.json last, by atomic rename. Writing settings.json is the switch itself, so a failure before that changes nothing that's in use.
- **Personal details stay out of the repository.** The user's `~/.claude/CLAUDE.md` becomes a short personal file that imports the rules (`@~/.claude/crosscheck/RULES.md`) and holds the personal lines: the MT5 standing confirmation for the user's own PC (named there, not here), and anything else that belongs only to this user. The public repository never holds secrets, account numbers or EA code.
- **Update:** `git pull`, then `node install.js`. Going back to an earlier driver version is `git checkout <version>`, then `node install.js`.
- **The old setup is retired** (2026-10-20): `install.js --restore` and the first install's backup that it put back are gone, and the installer no longer knows the old setup's hooks or state. Switching crosscheck off is `crosscheck off`.
- **No more release or backup machinery.** The repository is the release.

## 12. Tests (only what protects real harm)

The tests use Node's built-in runner (`node --test`), an isolated temporary home folder, and a Codex stub that returns canned JSON. They cover:

1. GPT isolation: the exact Codex arguments per mode; research is the only mode with web access; `write` stays read-only.
2. Computer lockdown: one success, plus a refusal for each of these: a listing that fails, unreadable output, a name that can't be switched off, something left enabled, and a look-alike `node_repl` from outside Codex's folder.
3. Risk gate: a trading file without a plan is refused; a skip unlocks it; a GPT escalation can't be skipped; a changed task makes an old skip stale.
4. Baselines and acknowledgement: a Write over a file with uncommitted changes keeps its original; only the frozen version counts; a file edited during the review stays pending; a changed task file acknowledges nothing; a review that includes a file already under review is refused.
5. Findings: an open BUG blocks Stop, but only once in a row; a GAP never blocks; closing a chain needs a reason per BUG, and the round limit is no reason.
6. Answers: missing or duplicate requirement ids, an unknown follow-up id, and a clean verdict next to a maintained BUG are each refused.
7. Pair merge: both found it, both labelled it GAP (it stays a GAP), confirmed, disputed, a NOT MET row linked to disputed findings, and a failed side recording nothing.
8. Follow-ups: ids, the round limit, rounds limited to fixed lines after it, and a file that turns risky mid-chain.
9. Commit guard: a commit while a tracked change is unreviewed, or a BUG is open, is refused.
10. Desktop gate: two projects compete for the desktop; a dead driver with a live worker keeps the desktop; Claude's screen tools work only inside an `allow-screen` window; the hook fails closed.
11. Plan gate: a plan changed after its review is refused, and a skipped one with a reason passes.
12. Fallback: an edit after the fallback review isn't acknowledged by it.
13. Atomic state: an unreadable state file is never overwritten.
14. Fixed-lines rounds: a regression caused by a fix is reported, and the task stays unfinished.
15. Install in an isolated profile: unrelated hooks are kept, an earlier install's hooks are replaced, and state is untouched.
16. Session scope: a review never acknowledges another session's changes unless they are named.
17. Review skip: refused when any file is risky, and recorded with its reason when it is allowed.

Each real bug found later gets one regression test, and there are no tests for anything else.

## 13. What the old setup had that the rewrite drops, and why

- **The requirement-list ceremony** (task --start, --update or --same after every message, words-file rules, strict requirements text block): replaced by `task.md`, updated only when the request changes, plus JSON requirement rows in the review.
- **The `done` check:** the final review already checks every requirement against the code, so done added a slow GPT run that mostly flagged items outside the task.
- **`score`:** a review with the rubric in `task.md` does the same.
- **`run` and its evidence records, and `triage`:** never used. Claude runs tests itself and passes the output; CodeRabbit comments are short.
- **`mql5-compile`:** the mql5-coding skill compiles (`Compile-Mql5.ps1`).
- **Paired runs for ideas, test plans and investigations:** the rules never pair them.
- **The word-vocabulary risk scanner:** too noisy (section 6).
- **Shell-change tracking, discovery windows, cross-project receipts:** Edit/Write tracking, `--files`, git (every project is a repository) and the commit guard cover them.
- **Ignore globs:** with no shell tracking there is nothing generated to ignore, and an ignore list could hide changes.
- **Cut after Fable's review** (not worth their code):
  - content-matching and flag parsing in the commit guard (it only has to catch Claude slipping);
  - review ordering by freeze time (one review per file at a time removes the problem);
  - install staging and automatic rollback, and two restore modes (git already keeps the versions);
  - per-project risk lists (no project needs one yet);
  - the 2-minute desktop window.
- **Re-checking a review when a file it depends on changes later:** the rule "no edits while a task's reviews run" covers it without machinery.
- **Markdown answer parsing,** with its decoration-blind readers and line grammars: one JSON schema replaces all of it.
- **Replaying finding ids from logs:** ids live in state.
- **Release, backup, manifest and mirror machinery:** the repository is the release.
- **`stats`, `apply`/`discard`, the prompt-hook reminders, the hook after edits, the duplicate-review check (one review per file at a time covers it), legacy chain formats:** not needed. `allow-claude-cu` becomes the simpler `allow-screen`.

## 14. Facts learned the hard way (carried over, so nothing has to be rediscovered)

1. Codex's sandbox covers shell commands, not MCP tools. Isolation needs `--ignore-user-config` and the feature switches. `--ignore-user-config` alone still exposed about 1,100 app connector tools.
2. `-c mcp_servers.<missing>.enabled=false` makes Codex refuse to start ("invalid transport"): only switch off servers that are listed.
3. A single plugin's switch works only unquoted (`-c plugins.<id>.enabled=false`) and only for plugins installed on this PC. The plugins on the ChatGPT account go only with `features.remote_plugin=false`. `features.plugins=false` also removes `cua_repl`, which breaks computer use.
4. `codex plugin list --json`, `codex mcp list --json` and `codex features list` honor `-c` and report the effective state.
5. Follow-ups resume with `codex exec resume <session id>`. Resume has no `-s` or `-C` flag, so the sandbox is set through config there.
6. Model answers: one strict machine block with one repair beats any attempt to read decorated text. Never rewrite model text.
7. Language modeling in a risk check (comment exemptions, statement windows) drew new high-severity findings in every round. Keep risk rules simple and file-level.
8. Test plans: at most 5 cases, no variants. Chasing coverage produced about 10 times more test code than real code. A missing test without real harm is a gap.
9. Never edit the driver's files while its tests run. Test the installed copy against a copy, or run the tests before installing.
10. Hide secrets when reading config files, including keys inside URLs. GPT may later read the transcript.
11. A running Claude desktop app writes its in-memory settings back over its config file. Edit that file, then restart the app.
12. Windows: paths with spaces and non-ASCII letters, UTF-16 files, process trees (Codex starts children, and killing the parent alone leaves them running), and the slow `npm root -g` (find Codex once and store the path).
13. A risky-review receipt counts only for the files the reviewers read whole. A chain's start time must be exact: whole-second log stamps let a same-second review pass as later.
14. GitHub: never `--admin`, never force-push. A PR is done when its final head commit is green and every CodeRabbit comment is handled.
15. Claude Code honors a hook's `"onFailure": "block"` only from version 2.1.295; older versions run a crashed hook as "allow".
16. `codex exec --output-schema <file>` (and `codex exec resume --output-schema`) makes GPT's final answer follow a JSON Schema. `doctor --live` checks that it is enforced on the installed version.
17. Claude Code passes a Stop hook `stop_hook_active` when Claude is continuing because of that same hook's block. That is enough to block only once in a row.
18. Test stubs record what they were sent and return canned answers. They never model an external tool's behavior (a stub that imitated GitHub's API drew new findings every round). The real tool is checked once, live and read-only (`doctor --live`).
19. In PowerShell, `git commit -F -` with a here-string doesn't read stdin. Write the message to a file and use `-F <file>`.
20. A relative path must be resolved from the project's root, not the shell's current folder (it once pointed reviews at the wrong project). An ambiguous or missing path stops the call.
21. Writing `KNOWN_GAPS.md` in place, or closing a chain before its gap entries are saved, could lose entries. Write atomically, and record the gaps before closing.

## 15. The rules Claude follows (draft of `RULES.md`, imported by the personal CLAUDE.md)

The rules say *what* to do; the driver handles *how*, so no command flags or hook details appear here. Target: 60 to 80 lines, against about 140 today.

- **Priority when rules conflict:** first, the safety of money, data and security; then the user's explicit instruction; then quality (real bugs fixed); then speed; then token cost.
- **Talking to the user:**
  - the answer or decision first, then the reason;
  - short replies in plain English, and a technical term explained the first time;
  - no internal ids, file paths, logs or long lists unless asked;
  - progress updates of one line, with detail only when asked;
  - when Claude must ask, one question at a time, with a recommendation;
  - Claude pushes back first (section 1, principle 6).
- **Roles and ground rules:**
  - Claude writes all code. GPT reviews, plans, reads large material and operates the screen, always read-only and isolated.
  - Claude never changes its own effort level or its settings.
  - Code is edited with Edit/Write, so the driver sees it.
  - Neither model trades, moves money or enters credentials.
  - Writing is not sending: no email, publishing, pushing or new repository without the user's OK. The standing approvals are: auto-fix is on for every PR, and a PR is merged when it's green.
  - The driver is switched off only when the user asks.
- **Code:** section 1, principles 1 to 5, word for word.
- **Facts first:** when an external tool's behavior matters and is uncertain, Claude checks its docs and runs small experiments before designing, and records the facts in the task notes.
- **A task:** section 2, word for word. One exception to "every code change gets reviewed": a task that only touches comments, formatting or docs may skip GPT with a recorded reason. Renames and anything else still get reviewed, and risky files never skip.
- **Recurring confirmed mistakes** go into the project's lessons.
- **Findings:**
  - BUG means it can really happen and cause real harm. In risky code (money, data, security, trading), an unlikely trigger with a big possible loss is a BUG too, such as duplicate orders, an order without a stop loss, a migration that loses rows, or a leaked key.
  - GAP means everything else, recorded with its severity.
  - Claude makes the final call. In risky code, a BUG becomes a GAP only with a one-line proof that it can't happen. Closing a review chain or hitting the round limit never turns an unfixed BUG into a gap by itself.
  - Paired reviews: a finding both reviewers found on their own needs no cross-check (BUG, unless both labelled it harmless). For the rest, each reviewer checks the other's findings: it can happen means BUG; shown impossible means GAP; still unclear means BUG in risky code.
  - Claude fixes an existing gap only when the current change makes it realistic.
  - A missing or weak test is rated by its real harm, not by the test case's rating.
  - When Claude is unsure whether a finding is real, it fixes the finding in trading or money code and records a gap elsewhere.
  - CodeRabbit gets the same rules: Claude auto-fixes its real bugs, and records nitpicks as gaps with a reply.
- **When GPT is needed:**
  - every code change, through the task's one review (the exception is under "A task");
  - plans before leaving plan mode, and substantial plans written in chat; a plan too small to matter is skipped with a reason;
  - an idea check, only for advice on risky or hard-to-undo decisions;
  - big reading jobs (logs, tester reports, unfamiliar code), web lookups, long documents and screen control.

  GPT is not needed for questions of fact or advice that isn't risky.
- **Background:** GPT runs in the background. Claude never polls; it works on something else, never on the files under review, or ends the turn while it waits. A big review can be split into parallel runs over different files.
- **If GPT is unavailable:** the fallback reviewer takes over (section 7), and Claude tells the user.
- **Computer use:** section 9.
- **Pull requests:** push only complete, reviewed work, never with `--admin` and never force-pushed. A PR is done when its final head commit is green and every CodeRabbit comment is handled.
- **Documents:** long documents are drafted by GPT and reviewed by Claude; short texts Claude writes itself.

The personal `~/.claude/CLAUDE.md` holds only what belongs to this user and this PC: the import line, and the MT5 standing confirmation for the user's own PC, named only in that file (run tester smoke tests without asking on that PC only; ask on any other PC or for a real-money account).

## 16. Building it (order and checkpoints)

1. **How this design was checked:**
   - two GPT plan-review rounds;
   - two Fable reviews, the last of which verified the facts on this PC: Claude Code 2.1.299, Codex 0.162.1, Node 24;
   - a full re-read;
   - a line-by-line comparison with the old setup's rules, reference, lessons, gaps and install docs.

   Rejected on purpose, and staying rejected unless something new comes up:
   - machinery for re-checking a review when a dependency changes;
   - "a disputed finding isn't a gap";
   - dropping the pair's cross-check;
   - treating GPT's risky rating as a warning;
   - letting code changes skip GPT (beyond the comments, formatting and docs exception);
   - making the trading-file gate a reminder.
2. **Build in small steps** of about 300 lines or less, each with its tests:
   1. `state.js`, `answer.js` and `codex.js` (isolation and lockdown), plus a first `doctor --live`, run against the installed Codex (0.162.1) before `review.js` is written, because every Codex flag in this design was verified at that version. The config file records the verified version from day one;
   2. `review.js` and `gaps.js`;
   3. `pair.js`;
   4. `hook.js`;
   5. `crosscheck.js`;
   6. `install.js` and `RULES.md`.
3. **The old setup reviews the new code** while it is being built. The new driver reviews itself only after the switch.
4. **The switch.** It is global, since hooks and rules apply to every project; there is no technical half-switch.
   1. The old setup's open findings and pending changes are settled.
   2. Install, restart Claude Code, then `doctor --live` must pass on the installed Codex version.
   3. The first day's work stays in one project. (A one-step switch back to the old setup existed until the old setup was retired, section 11.)
5. **Commits and pushes** to this repository follow on the user's OK. Building works on branches with pull requests, like the old repository: CI and CodeRabbit check every pull request, and it's merged when green.

## 17. Name

**crosscheck.** It says exactly what the tool does: every change Claude writes gets checked by a second mind, and risky changes get two GPTs checking each other. It's short and works for any kind of project. It also drops the old repo's "master/slave" wording. The repository is `shamwi2846/crosscheck-review`, created by the user on 2026-10-19. The command (`crosscheck review`) and the installed folders (`~/.claude/crosscheck/` and `~/.claude/crosscheck-state/`) use the short name.
