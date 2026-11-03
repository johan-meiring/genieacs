# CLAUDE.md

@AGENTS.md

## Claude-specific notes

- Project history from the previous Codex work (what was built, why, and what went wrong): see [docs/codex-history.md](docs/codex-history.md). Read it before changing logging, the build script, or deployment advice.
- Raw Codex session logs are archived locally in `codex-archive/` (git-excluded via `.git/info/exclude`; contains logs, IPs and device IDs — never commit or quote them wholesale).
- Claude's cloud workspace cannot SSH to devmonitor. Run git/build/test on devmonitor via the linked computer's shell, or hand Johan the exact commands. Don't try to commit through the `M:` mount.
- No MCP servers or custom prompts were carried over from Codex (its only MCP server was its own built-in browser/computer-use runtime).
