# ZCode Pool for VS Code

A workspace extension for a separately running ZCode Pool daemon. Open **ZCode Pool: Open Workbench**, check the displayed host and pool, then explicitly **Connect**. Activation, opening a view, F5 and closing VS Code never launch or stop a daemon, worker or model task. The explicit **启动后台并连接** action can start a separately installed daemon; it does not start workers or models.

## Install and connect

Install the locally built VSIX with **Extensions: Install from VSIX**. This package is a bundled UI client: it contains no daemon, Node runtime, accounts or pool. Install/start the standalone daemon separately on the same Linux host. Source installation and standalone distribution instructions are in the project's `docs/distribution.md`. Set `zcodePool.poolHome` to an absolute path in that host's User/Remote Settings; an empty value uses `~/.zcode_pool`. Use **选择连接目录** to enter the host-side absolute pool path directly. Connect only reads capabilities and snapshots. The extension never calls a workspace npm script or searches for a source checkout. To start an installed daemon from the workbench, use **启动后台并连接** in a trusted Linux workspace. The default CLI is `~/.local/share/zcode-pool-app/node_modules/zcode-pool/bin/zcode-pool.mjs`; override it with host User/Remote `zcodePool.daemonCliPath`. Set `zcodePool.daemonNodePath` to Node 24+ or leave it empty to discover `node` in absolute host PATH directories. No automatic downloads or installation are performed.

Real connections require a Linux workspace extension host. Local Linux is exercised by automated tests; Remote SSH Linux and WSL use the same host-side socket/file picker design but require environment acceptance testing. Windows/macOS can run mock development; pure browser VS Code is unsupported. Codespaces/containers remain unverified. VS Code 1.95 or later is required; the daemon requires its own Node 24 installation, independently of the extension host's Node version.

## Controls and evidence

Tasks and Resources are native trees; the workbench has task history, event and UTF-16 patch paging, an explicit task composer, resource actions, quota source/timestamps, complete permission review and immutable base/final Diff. Capabilities and fresh per-task controls gate each operation. Restricted Mode permits explicit read-only connections and blocks every mutation in the Host. Legacy daemons remain read-only and only show their recent 50-task window.

Dispatch uses a stable request ID and stores only recovery IDs, a payload digest and resource identities. After an unknown outcome, look up that original request; no write is automatically retried. Prompts and approval content remain in memory. Approval replies bind the complete canonical hash, owner and revision. An acknowledgement means awaiting native confirmation; disappearing pending entries do not prove whose response was used. The native runtime lacks a compare-and-swap reply API; local revalidation cannot remove that upstream race.

Cancellation requests retain occupancy until stopped execution is proved. **核对执行状态** can update records and release proved occupancy without sending a model turn or running verification. **恢复观察** may finish existing verification or use a qualified remaining bounded busy continuation. No force-stop, force-unlock, account rotation, workspace merge or cleanup command is supplied.

Historical file Diff reads registered immutable artifacts and verifies all bytes and hashes. It never substitutes current workspace files. It is cumulative relative to the workspace base commit. Nonignored untracked files appear separately from the Git patch; binaries, missing legacy snapshots and files above the 2 MiB editor limit have explicit limitations. A local reviewed marker binds authority, pool/store, task and manifest hash; it changes no daemon state.

## Development

From the repository root, run `npm --prefix extensions/vscode ci` and `npm --prefix extensions/vscode run build`. F5 defaults to **Mock UI (no daemon)**. Development-only environment variables select an in-memory validated fixture; mock failures never fall back to real connections. The second F5 profile merely preselects a real pool; Connect remains explicit. Choosing a new connection directory or changing host Settings overrides the initial F5 directory without a restart. Production ignores all debug environment variables and excludes fixtures.

Use `test:unit`, `test:integration`, `test:smoke` and `test:browser` for the separate checks. Electron smoke requires a desktop/Xvfb session and downloads official VS Code test binaries. `package:vsix` builds the bundle; `package:check` inspects the allowlisted archive. These default tests send no real model request.

`test:real-model` is a separate opt-in acceptance runner and skips before any connection unless `ZCODE_POOL_RUN_REAL_MODEL=1`. An enabled run also requires explicit `--pool-home`, `--worker-id`, `--workspace-id`, `--prompt-file`, `--verify-commands-file`, `--model-id`, `--mode`, `--session`, `--busy-retry-limit` and a new `--receipt-file` path. The verification file is a JSON array of `{command,args,timeoutMs}` objects. It dispatches once and observes the original task; approvals remain a manual UI action. It never automatically approves, probes, resumes, cancels or retries. Default build, F5, smoke and CI paths do not enable it.
