# Codex history (2026-11-02)

Summary of the Codex sessions on this project before the move to Claude. Raw logs and readable transcripts are in `codex-archive/` (local only, git-excluded). The original pre-Codex context is in `CODEX_HANDOFF_GENIEACS.md` (work before Codex was done in ChatGPT and produced the original workaround commits).

All of this work was later consolidated into one commit per feature on `cwmp-updates`, so the changes below are described by name rather than by commit hash.

## Sessions

| Codex thread | Time (SAST) | Content |
|---|---|---|
| `01a19b7c…` "Find recommended Codex model" (later moved into the GenieACS project) | 10:59–14:52 | All the project work below |
| `01a19bce…` "Check Codex token usage" | 12:29 | How to view Codex usage — not project related |

## Timeline

1. **Repo setup.** Codex generated an SSH key and tried to `git init` on `M:`. Git failed with I/O errors: SFTP Net Drive 2017 **cannot rename a file over an existing one**, which git needs for `.git/config` etc. Johan wanted `.git` to stay inside the project, so Codex switched to **SSH as root on devmonitor** and checked out the repo at `/root/jmdev/genieacs/source-updates/codex`. Johan created a separate devmonitor → GitHub SSH key for pushing.
2. **Logging change (log configured GPN overrides and injected objects).** INFO logs for `Forced GPN NextLevel=false` and `Forced GPN object added`, only when a configured rule actually fires / an object is actually inserted. Codex set up a private Node runtime on devmonitor (`/root/jmdev/codex-tools/`) because Johan clarified the checkout is source only. Validated with build, 25 tests, 14 focused simulated-session checks, ESLint, TypeScript. Pushed.
3. **Blank UI page.** `genieacs-ui` showed a blank page until restarted. Codex found `app-IKDAEJFF.js` returning 404: the running UI referenced assets from a previous build that `npm run build` had replaced. Fix: **restart all genieacs services after every build.** The fork commits don't touch the UI.
4. **"Logs missing."** Johan's debug trace showed `AssociatedDevice.` was injected for WLAN 2/3/4 (WLAN 1 reported it itself), but nothing in the log file. The messages were going to the journal (`logger.info` → stderr, `GENIEACS_CWMP_LOG_FILE` unset).
5. **Access-log routing (send GPN workaround events to the access log).** At Johan's request, both GPN events now use `logger.accessInfo`; the incomplete-DeviceId warning already used the access logger. Pushed.
6. **Still missing after restart.** Production source had the access-log routing change, but `dist/bin/genieacs-cwmp` was built at 12:00 and still called the app logger — Johan had restarted without rebuilding. Lesson: confirm the **compiled binary**, not just the source.
7. **Build failure (`fix(build): handle quoted and multiline untracked filenames`).** `npm run build` failed with `ENOENT … "-lh --time-style=long-iso \\"`: an untracked file with that odd name (likely from a pasted shell command) was in the production checkout, and `getBuildMetadata()` used git's quoted newline-separated output. Fixed to use NUL-separated output, made build failures exit non-zero, added a regression test (26 tests). Pre-existing bug, exposed by the new file — not caused by the logging commits. Pushed.
8. Johan confirmed **"all working now"** — access log receives the events in production.
9. Johan asked Codex to update `CODEX_HANDOFF_GENIEACS.md` with the completed changes, access-log settings and correct build/restart instructions. The session log ends mid-edit, but the update was completed and pushed: the handoff now documents the completed changes, logging behaviour, both incidents and the hardened deploy procedure (`npm ci --include=dev`, backup branch, fail-fast subshell).

## Lessons carried forward

- Run git on devmonitor over SSH, not on `M:`.
- Build → check binary timestamp → restart **all** services. Restart alone ≠ deploy; build alone breaks the UI.
- `logger.info` vs `logger.accessInfo` go to different destinations.
- Verify on the running build before claiming something is "confirmed".
