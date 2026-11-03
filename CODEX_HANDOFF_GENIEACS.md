# GenieACS CWMP fork — Codex project handoff

- **Repository:** https://github.com/johan-meiring/genieacs
- **Published working branch:** `cwmp-updates`
- **Upstream baseline used for the original work:** GenieACS v1.2 (`e773297`)
- **Production source checkout:** `/opt/genieacs-source/genieacs` on a Linux ACS
  host
- **Development checkout:** `/root/jmdev/genieacs/source-updates/codex` on
  `devmonitor.frogfoot.net`
- **Last updated:** 2026-11-02 (Africa/Johannesburg)

**Requested workflow:** Keep each independent functional change in its own Git
commit. Test against the actual checkout and never assume a previously generated
`.patch` will apply to the current tree.

## Purpose

This fork adds CWMP workarounds for ONTs whose TR-069 implementation has quirks.
Earlier changes were developed in a ChatGPT conversation. Continue in Codex
using the Git repository as the source of truth; the notes below are context,
not a replacement for code inspection.

## Existing modifications

1. **Forced discovery of missing GPN object paths** (`lib/session.ts`). Some
   ONTs (seen on Calix-family units) never report the `AssociatedDevice.` object
   in GetParameterNames responses. The code inserts configured missing object
   names into the response and queues object-level `GetParameterValues` probes. It must not invent numbered parent
   instances or duplicate paths already present.
   - Admin → Config: `cwmp.forceAddManufacturers`:
     comma/semicolon/newline-separated manufacturer names, exact
     case-insensitive matching.
   - Admin → Config: `cwmp.forceAddObjects`: object paths with `*` matching an
     existing numeric instance (e.g.,
     `"InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.AssociatedDevice."`).
   - **Both settings are required**. No implicit `Calix` or `FROGFOOT` default;
     no injection if either setting is absent or empty.
   - Inspect `getForceAddConfig`, `getForcedObjectPatterns`,
     `matchesForceAddManufacturer`, `forcedObjectProbePaths` and the
     `ForcedObjectProbe` request type in `lib/session.ts`.

2. **Forced recursive GetParameterNames** (`lib/session.ts`). Admin → Config
   `cwmp.forceNextLevelFalse` is a list of object paths; `*` matches one numeric
   instance, e.g.
   `"InternetGatewayDevice.,InternetGatewayDevice.LANDevice.*.WLANConfiguration.*."`.
   For a matching requested path, force `NextLevel=false` / `0` instead of
   following the normal `estimateGpnCount` heuristic. **Without configuration,
   do not force anything.** Preserve GenieACS's sync-state updates for recursive
   GPN, not merely the serialized SOAP flag. Inspect `forceRecursiveGpn` near
   the GPN scheduler.

3. **Malformed Inform DeviceId handling** (`lib/cwmp.ts`, `lib/soap.ts` and
   possibly `lib/config.ts`). An Inform can have blank `Manufacturer`, `OUI`,
   `ProductClass`, and/or `SerialNumber`; a factory reset may be necessary.
   Admin → Config `cwmp.invalidDeviceIdRecovery` supports `"disabled"`
   (default), `"log"` (record source IP and invalid fields, without reset), and
   `"reset"` (send `InformResponse`, then a `FactoryReset` RPC during the same
   CWMP session, without normal persistent device identity). The current code no
   longer consults `GENIEACS_INVALID_DEVICEID_RECOVERY`; use Admin → Config
   instead. The reverse proxy authenticates ONT clients; GenieACS has
   `cwmp.auth=true`. `cwmp.connectionRequestAuth=AUTH(username, password)` is
   for ACS-initiated connection requests, not Inform auth. Recover source IP
   from trusted forwarded headers; avoid trusting arbitrary client-supplied
   headers. Treat reset as destructive; test log mode first.

## Completed changes

`cwmp-updates` holds one commit per independent change on top of the
`e773297` baseline:

| Commit subject                                                            | Content                                                                                                     |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `docs: add AI agent instructions, Codex handoff and history`              | `AGENTS.md`, `CLAUDE.md`, this handoff and `docs/codex-history.md`.                                         |
| `fix(build): handle quoted and multiline untracked filenames`             | Build metadata fix, nonzero exit status on build failure, regression test.                                  |
| `feat(cwmp): configurable forced GPN NextLevel=false with access logging` | `cwmp.forceNextLevelFalse` and the `Forced GPN NextLevel=false` access-log event.                           |
| `feat(cwmp): inject configured missing GPN objects with access logging`   | `cwmp.forceAddManufacturers`/`cwmp.forceAddObjects`, the GPV probe and the `Forced GPN object added` event. |
| `feat(cwmp): configurable handling of incomplete Inform DeviceId`         | `cwmp.invalidDeviceIdRecovery` (`disabled`/`log`/`reset`) and its access-log events.                        |

The user confirmed that building and access logging work in production. No
logging implementation task remains outstanding.

## CWMP access-log behavior and configuration

All three requested event categories use the existing access logger. Do not
replace these calls with `logger.info` or append directly through filesystem
APIs.

| Event                      | Message / level                              | Trigger and fields                                                                                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configured recursive GPN   | `Forced GPN NextLevel=false` / INFO          | A `cwmp.forceNextLevelFalse` rule matches. Includes device identity and source IP from `sessionContext`, plus `parameterPath`. An ordinary heuristic decision to use false does not produce this event.                                                                                                     |
| Forced object insertion    | `Forced GPN object added` / INFO             | A previously unreported object is actually inserted into the parsed response. Includes session identity/source IP, `objectPath`, and the parent request's `parameterPath`. No insertion log for an already-reported object, its reported descendants, or a direct empty-object GPV probe without insertion. |
| Incomplete Inform identity | `CWMP Inform has incomplete DeviceId` / WARN | Missing fields with `cwmp.invalidDeviceIdRecovery` set to `"log"` or `"reset"`. Includes source/peer IP, missing field names, bounded available identity fields, and recovery mode. Recovery progress/errors also use the access logger.                                                                    |

The default DeviceId recovery mode remains `"disabled"`. Detailed missing-field
logging is opt-in; existing missing OUI/serial rejection errors still use the
access logger. Never enable factory reset simply to test logging. Start with
`"log"` when investigating an affected ONT.

Set these in the environment file actually loaded by the production systemd
unit:

```ini
GENIEACS_CWMP_ACCESS_LOG_FILE=/var/log/genieacs/genieacs-cwmp-access.log
GENIEACS_CWMP_LOG_FILE=/var/log/genieacs/genieacs-cwmp.log
```

The first setting selects the requested event destination. The second is
optional and keeps application/process messages in a separate file. Without a
configured application log, those messages go to stderr and normally appear in
the journal; without a configured access log, access messages go to stdout. Log
directories and files must be writable by the service account. Environment
changes require a service restart, not a source rebuild. Do not copy environment
secrets into this handoff.

The two GPN messages were first written with the application logger, which
explains the earlier observations in `journalctl`; they were then moved to the
access logger. Do not assume the source revision proves which compiled code is
running.

## Production update, build, and restart procedure

Production host: `cpt-ffhq-acs1.frogfoot.net`. The verified CWMP `ExecStart` is
`/opt/genieacs-source/genieacs/dist/bin/genieacs-cwmp`. This is separate from
the development checkout on devmonitor; tests/builds on devmonitor do not deploy
production.

First inspect the production checkout and preserve any local changes or commits:

```bash
cd /opt/genieacs-source/genieacs
git status --short --branch
git remote -v
git log -5 --oneline
```

Proceed only after accounting for local changes. Use a maintenance window: CWMP
restarts interrupt active ONT sessions, and rebuilding the live `dist` directory
can temporarily disrupt UI assets. Do not use `git reset --hard`, `git clean`,
or force pushes to resolve a divergent checkout.

Run the following in Bash. The subshell stops on a failed command without
changing the interactive shell's options:

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
  test -s dist/bin/genieacs-cwmp
  test -s dist/bin/genieacs-ui
  stat -c '%y %n' dist/bin/genieacs-cwmp dist/bin/genieacs-ui
  sudo systemctl restart genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
  sudo systemctl is-active genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
)
```

`--include=dev` ensures the build tools are installed even if npm is configured
to omit development dependencies. Deprecation and audit warnings from a
successful `npm ci` are separate from build failures; do not run
`npm audit fix --force` as part of this procedure. If a fast-forward pull fails,
reconcile the histories while preserving independent patches before continuing.
If any install/build step fails, investigate before restarting services. Some
late build failures can leave `dist` incomplete; inspect the failure stage
rather than assuming it is safe.

The user is happy to restart all four services after a successful build. An
agent must still follow the current request's deployment authorization; do not
deploy, restart production, or push commits merely because these instructions
are present.

After the restart:

```bash
sudo systemctl show genieacs-cwmp -p ExecStart -p ActiveEnterTimestamp
sudo journalctl -u genieacs-cwmp -u genieacs-ui --since '-5 minutes' --no-pager
sudo tail -n 100 /var/log/genieacs/genieacs-cwmp-access.log
```

Trigger an ordinary ONT refresh under the existing configuration and check for
`Forced GPN` entries when rules actually match/inject. A device with a complete
identity will not produce an incomplete-DeviceId event. Hard-refresh the browser
with Ctrl+Shift+R and verify its referenced JavaScript assets return HTTP 200.

### UI blank-page incident

The HTML referenced `app-IKDAEJFF.js`, but that asset returned 404 while the
HTML, CSS, and `/status` returned 200. The build embeds hashed asset filenames
into the backend and recreates `dist`. A UI process left running across an
in-place rebuild can retain old filenames whose files have been removed. Restart
**genieacs-ui as well as CWMP** after a new build. A successful source pull or
restarting an old binary alone does not deploy the new build. If blank pages
recur without another build/deployment, investigate browser Console/Network and
server logs separately.

### Build filename incident and fix

The build failed with `ENOENT` while opening a Git-quoted filename resembling a
pasted shell-command fragment (`-lh --time-style=long-iso` followed by a
backslash). The old metadata code split
`git ls-files --others --exclude-standard` on newlines and treated its quoted
output as literal paths. The logging commit did not change that code; an unusual
local untracked filename exposed the existing bug. How that file was created was
not established.

The build fix moves metadata generation into `build/build-metadata.ts` and reads
Git's NUL-separated `-z` output, preserving literal filenames. Its regression
test is `test/build-metadata.ts`. The build catch handler now sets
`process.exitCode = 1`. The reported metadata failure occurs before `dist` is
replaced, explaining why restarting afterward still loaded the older compiled
logging behavior. Do not identify logger destinations from minified function
names alone.

## Source locations and validation

- `lib/session.ts`: configuration matching, recursive GPN scheduling,
  forced-object insertion, and both `logger.accessInfo` calls. Search symbols
  rather than stale line numbers: `forceRecursiveGpn`,
  `getForcedObjectPatterns`, `forcedObjectProbePaths`.
- `lib/cwmp.ts`: `getInvalidDeviceIdRecoveryMode`, `incompleteDeviceIdFields`,
  `invalidDeviceIdLogFields`, and the access-log/recovery branches.
- `lib/logger.ts`: `accessInfo/accessWarn/accessError` use the access stream;
  `info/warn/error` use the application stream. Session identity and trusted
  source IP are flattened through the existing logger/forwarded-header
  machinery.
- `build/build.ts`, `build/build-metadata.ts`, `test/build-metadata.ts`: build
  fix.

Validation on the actual devmonitor checkout passed: production build, all 26
repository tests after the build fix, ESLint, TypeScript, and formatting checks
on the build changes. Fourteen focused simulated-session checks also verified
GPN log fields, access-stream routing, positive triggers, and silent negative
cases. The focused harness is local at
`/root/jmdev/codex-tools/test-gpn-access-logging.cjs`; it is not a tracked test.
The separate test runtime is located via `/root/jmdev/codex-tools/node-path`.
Pre-existing formatting issues in `lib/session.ts` and `lib/cwmp.ts` were left
alone; check before applying whole-tree formatting. No credentials or private
keys belong in the repository or handoff.

## Prior test observations

- With no associated wireless clients, one Calix-family/FROGFOOT-branded ONT
  returned a WLAN GPN response with no `AssociatedDevice` subtree (79 names).
  The workaround sent an object-level GPV, and the ONT returned an empty
  `ParameterList`, with no fault.
- With a laptop associated, the same WLAN reported an `AssociatedDevice.1`
  subtree (105 names) and returned its leaf values, including MAC, IP, RSSI, and
  statistics in normal GPV processing.
- A subsequent check still showed the client record with unchanged statistics
  after possible disconnection; **stale ONT association state is a separate
  investigation** and should not block this logging change.
- Multiple WLANConfiguration instances 1/2/3/4 are supported by pattern matching
  when actually present.

## Continuing work

1. Read this handoff, current repository instructions if present, and inspect
   `git status --short --branch`, the current HEAD, and remote `cwmp-updates`.
2. Preserve all existing functional commits and unrelated working files. Verify
   the checkout rather than applying historical generated patches blindly.
3. Keep future independent changes in separate commits. Run appropriate tests,
   build, lint/type checks, and review the exact diff before publishing.
4. Treat stale ONT association statistics as a separate, still-open
   investigation only if the user asks to pursue it; do not reopen completed
   logging work.
5. Obtain the user's authorization for pushes or production actions. Development
   SSH access does not imply SSH access to the production host.

## Production cautions

- Don't include credentials, password values, session cookies, full CWMP Inform
  bodies or private subscriber data in logs or commits. CWMP debug traces may
  contain ACS connection-request passwords and Wi-Fi credentials.
- FactoryReset functionality is sensitive and production changes should keep
  default `disabled`; never enable reset mode incidentally.
- Some previous hand-written Git patches failed on context mismatch. Work from
  actual current checkout, not source snippets or fixture line numbers.
- Codex needs its own access to the repository and, for server-local builds or
  logs, explicit access to that machine. Cloud-only GitHub workspace does not
  automatically gain SSH access to the ACS server.
