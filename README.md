# crosscheck-review

crosscheck: Claude writes the code, GPT checks it. Claude Code hooks keep that loop honest: a commit waits until every changed file was reviewed and no BUG finding is open, trading files need a test plan (or a skip with its reason, which then gets the normal review instead of the paired one) before they are edited, a review acknowledges a file rated risky (by Claude or GPT) only with its test plan, and a plan is reviewed before Claude leaves plan mode. GPT runs through the Codex CLI, read-only and isolated, with web search; risky changes get two GPTs that check each other (or GPT and Muse, which can also search the web and view the project's pictures).

- Install or update: `node install.js` (Node 22 or newer, a logged-in Codex CLI, Claude Code 2.1.295 or newer, git), then restart Claude Code and run `node ~/.claude/crosscheck/crosscheck.js doctor --live`.
- Switch crosscheck off and on: `node ~/.claude/crosscheck/crosscheck.js off` (or `on`). The setup it replaced was retired on 2026-10-20, so there is no switching back to it.
- Commands: `node ~/.claude/crosscheck/crosscheck.js` with no arguments lists them.
- Tests: `node --test`.

How it works and why: [DESIGN.md](DESIGN.md). The rules Claude follows: [RULES.md](RULES.md).
