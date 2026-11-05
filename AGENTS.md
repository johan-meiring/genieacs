# AGENTS.md — GenieACS CWMP fork (Frogfoot)

Vendor-neutral instructions for coding agents (Claude, Codex, …). `CLAUDE.md` imports this file.
Detailed reference: `CODEX_HANDOFF_GENIEACS.md` (handoff — incidents, logger internals, validation details, full deploy procedure). Session history: `docs/codex-history.md`. If this file and the handoff disagree, check the code and fix whichever is wrong.

## Project

- Fork of GenieACS v1.2 adding CWMP workarounds for ONTs with quirky TR-069 implementations (Calix-family / FROGFOOT-branded ONTs).
- Repo: https://github.com/johan-meiring/genieacs — published branch **`cwmp-updates`** (upstream baseline `e773297`).
- Source checkout for development: `/root/jmdev/genieacs/source-updates/codex` on `devmonitor.frogfoot.net` (also mounted on Johan's PC as `M:\genieacs\source-updates\codex` via SFTP Net Drive). This is **only a code repository** — nothing runs from it.
- Production: `/opt/genieacs-source/genieacs` on `cpt-ffhq-acs1`; services `genieacs-cwmp`, `genieacs-nbi`, `genieacs-fs`, `genieacs-ui` run from its `dist/`.

## Ground rules

- Git is the source of truth. Inspect the actual checkout (`git status --short && git branch --show-current && git log -8 --oneline`) before editing; never assume a previously generated patch applies.
- One independent functional change per commit; conventional messages (`fix(cwmp): …`, `feat(cwmp): …`). Never rewrite existing history on `cwmp-updates`.
- **Do not push, deploy, or restart any service without Johan's explicit approval.**
- Never put credentials, connection-request passwords, Wi-Fi keys, session cookies, full Inform bodies or subscriber data in code, logs, commits or docs.
- `cwmp.invalidDeviceIdRecovery` must default to `"disabled"`; never enable `"reset"` (FactoryReset) incidentally.
- Don't reformat unrelated code — some existing files already fail Prettier; check only the files you touch.

## Working with the checkout

- The SFTP-mounted `M:` drive **cannot replace an existing file by rename**, so `git` (config/index/ref updates) fails there, and it is slow. Run git, builds and tests on devmonitor over SSH as `root`; use `M:` only for reading/creating files.
- Node/npm are not on the default SSH PATH on devmonitor; Codex installed a private runtime whose path is in `/root/jmdev/codex-tools/node-path` (`export PATH="$(cat /root/jmdev/codex-tools/node-path):$PATH"`).
- Origin is `git@github.com:johan-meiring/genieacs.git`; the devmonitor → GitHub key is `/root/.ssh/id_ed25519_github_devmonitor`. The repo's local `core.sshCommand` is set to `ssh -i /root/.ssh/id_ed25519_github_devmonitor -o IdentitiesOnly=yes`, so plain `git fetch`/`git push` work; without it they fail with `Permission denied (publickey)`.
- The checkout has a local **`cwmp-updates`** branch tracking `origin/cwmp-updates`; work happens on it directly. Fetch and check `git status --short --branch` before new work.

## Checks (run before proposing a commit)

```bash
npm run build      # esbuild build/build.ts | node — exits non-zero on failure (since the build-metadata fix)
npm test           # node --test, 26 tests
npx eslint 'bin/*.ts' 'lib/**/*.ts' 'ui/**/*.ts' 'test/**/*.ts' 'build/**/*.ts'
npx tsc --noEmit
npx prettier --check <changed files>
```

**Do not run `npm run lint`.** `build/lint.ts` runs ESLint, `tsc --noEmit` and `prettier --prose-wrap always --write .` in parallel; the Prettier step rewrites files across the whole repo (including untouched `lib/` and Markdown files). It also always exits 0 — ESLint and `tsc` failures are only printed. Use the separate read-only commands above; if `npm run lint` was run by mistake, `git restore` the files it changed.

## Fork features (all in `lib/`)

| Feature | Config (Admin → Config) | Code |
|---|---|---|
| Inject GPN objects the device never reports (e.g. `AssociatedDevice.` on Calix-family ONTs) and probe them with object-level GPV | `cwmp.forceAddManufacturers` **and** `cwmp.forceAddObjects` (both required; `*` = existing numeric instance; no defaults) | `session.ts`: `getForceAddConfig`, `getForcedObjectPatterns`, `matchesForceAddManufacturer`, `forcedObjectProbePaths`, `ForcedObjectProbe` |
| Force recursive GPN (`NextLevel=false`) for matching paths | `cwmp.forceNextLevelFalse` (nothing forced if unset) | `session.ts`: `forceRecursiveGpn` in GPN scheduler |
| Malformed Inform DeviceId handling | `cwmp.invalidDeviceIdRecovery` = `disabled` (default) / `log` / `reset`; optional `cwmp.invalidDeviceIdResetWindow` (e.g. `03:00-05:00, 23:00-01:00`, server local time) limits `reset` to those hours and uses `log` outside them (unset = reset any time) | `cwmp.ts`: `getInvalidDeviceIdRecoveryMode`; `soap.ts` |
| Non-blocking NBI connection request: `POST /devices/{id}/tasks?connection_request&async` (with a task body or empty) replies 202 at once and sends the connection request in the background instead of waiting for the session | Query flag `async` (opt-in; without it the NBI waits as before) | `nbi.ts`: `sendConnectionRequestInBackground`, `asyncConReq` |

### Logging (all via the **access logger**, `logger.accessInfo/accessWarn` with `sessionContext`)

| Event | Message | Level |
|---|---|---|
| Configured NextLevel override | `Forced GPN NextLevel=false` (+ `parameterPath`) | INFO |
| Object actually injected | `Forced GPN object added` (+ `objectPath`, `parameterPath`) | INFO |
| Incomplete DeviceId (`log`/`reset` modes) | `CWMP Inform has incomplete DeviceId` | WARN |
| NBI `async` connection request succeeded (NBI access log, `deviceId`) | `Background connection request sent` | INFO |
| NBI `async` connection request failed (NBI access log, `deviceId`, `status`) | `Background connection request failed` | WARN |

Destination: `GENIEACS_CWMP_ACCESS_LOG_FILE=/var/log/genieacs/genieacs-cwmp-access.log` (production sets this); the two NBI events go to `GENIEACS_NBI_ACCESS_LOG_FILE` (stdout if unset). `logger.info` goes to `GENIEACS_CWMP_LOG_FILE` or, if unset, stderr → journald.

Optional: `GENIEACS_CWMP_LOG_FILE=/var/log/genieacs/genieacs-cwmp.log` keeps application messages in a file instead of the journal. Env changes need a restart, not a rebuild.

## Deploying (Johan runs this on production, `cpt-ffhq-acs1`)

Full procedure with post-restart checks: handoff → "Production update, build, and restart procedure". In short, after `git status --short --branch` shows nothing to preserve:

```bash
(
  set -euo pipefail
  cd /opt/genieacs-source/genieacs
  git branch "backup-before-update-$(date +%Y%m%d-%H%M%S)"
  git fetch origin
  git switch cwmp-updates
  git pull --ff-only origin cwmp-updates
  npm ci --include=dev
  npm run build
  stat -c '%y %n' dist/bin/genieacs-cwmp dist/bin/genieacs-ui
  sudo systemctl restart genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
)
```

No `git reset --hard`, `git clean`, force pushes or `npm audit fix --force`.

Always restart **all** services after a build: the UI embeds hashed asset names (`app-XXXX.js`), so a UI process left running after a rebuild serves a page whose JS 404s (blank page). A restart without a rebuild runs the old binary. Restarting CWMP interrupts device sessions.

## Open items

- Stale ONT association state (client record persisting after disconnect) — separate investigation, not started.
