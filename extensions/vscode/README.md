# ZCode Pool for VS Code

A workspace extension for Codex to orchestrate ZCode tasks, with a task monitor, account quota views, shared concurrency controls, approval review and immutable delivery Diff. The VSIX bundles the ZCode Pool daemon, CLI and MCP runtime. Codex directs the work; the panel provides visibility and manual intervention.

## Install and connect

1. Install the VSIX with **Extensions: Install from VSIX** on the Linux workspace host, including the Remote SSH/WSL host when applicable. Provide Node.js 24+ and the official ZCode runtime. No separate ZCode Pool daemon package, npm command or source checkout is needed.
2. Open **ZCode Pool: Open Workbench**, check the displayed host and pool, then use **启动后台并连接**. It reuses an existing daemon or prepares and starts the bundled backend. An empty `zcodePool.poolHome` uses `~/.zcode_pool`; **选择连接目录** changes the host-side absolute pool path.
3. Prepare accounts, workers and isolated task workspaces in **额度与资源**. Import uses a native host-side OAuth JSON picker; it is not a `.zsb` backup importer.
4. Use **连接 Codex / 生成 MCP 配置**, add the generated configuration once to Codex on the same execution host, and reconnect Codex. Configuration generation does not modify Codex settings or prove a Codex connection. Confirm the connection by calling `zcode_overview` from Codex and checking that it sees the same pool.
5. Describe your goal, allowed changes and acceptance criteria to Codex. Monitor tasks and quota in the panel, review necessary approvals and inspect delivery Diff. The manual task form remains under **高级操作**.

MCP and the panel use a shared connection profile on the same host. After the panel changes pools, subsequent MCP tool calls read the new pool without adding the Codex server again. Existing tasks remain in their original pool; switching pools does not migrate or stop them. Opening a view, F5 and closing VS Code never start or stop a model task. **Connect** reads capabilities and snapshots; **Disconnect** leaves running work alone. The explicit backend start action does not start workers or models. The extension never executes a workspace npm script or downloads a backend.

Upgrading the extension or generating MCP configuration does not restart an existing older daemon. Review current tasks before explicitly stopping the old service and starting the new backend. The new backend migrates schema 1/2/3 databases to schema 4; older programs cannot open schema 4. Available UI features follow the capabilities of the running daemon.

The runtime is prepared in extension global storage when explicitly requested, with stable entry paths for MCP configuration. `zcodePool.daemonNodePath` can select Node 24+; otherwise `node` is discovered in absolute host PATH directories. Advanced users may set `zcodePool.daemonCliPath` to an existing external installation. Accounts, Node and the official ZCode runtime are not bundled.

Real connections require a Linux workspace extension host. Local Linux is exercised by automated tests; Remote SSH Linux and WSL use the same host-side socket/file picker design but require environment acceptance testing. Windows/macOS can run mock development; pure browser VS Code is unsupported. Codespaces/containers remain unverified. VS Code 1.95 or later is required; the daemon requires its own Node 24 installation, independently of the extension host's Node version.

## Controls and evidence

Tasks and Resources are native trees; the workbench defaults to task monitoring with quota and resource views. Settings show the pool concurrency limit and occupied/available slots. Limits range from 0 to 64, with an empty value meaning unlimited; 0 pauses new dispatches. Lowering the limit does not stop existing tasks. Approvals, verification and uncertain execution that still hold a lease occupy slots. Excess dispatches are rejected, not queued. MCP and the panel obey the same policy.

The panel also has event and UTF-16 patch paging, advanced manual dispatch, quota source/timestamps, complete permission review and immutable base/final Diff. Capabilities and fresh per-task controls gate each operation. Restricted Mode permits explicit read-only connections and blocks every mutation in the Host. Legacy daemons remain read-only and only show their recent 50-task window.

Dispatch uses a stable request ID and stores only recovery IDs, a payload digest and resource identities. After an unknown outcome, look up that original request; no write is automatically retried. Prompts and approval content remain in memory. Approval replies bind the complete canonical hash, owner and revision. Only actual pending approvals require review; the default mode does not bypass them with `yolo` or automatically approve them. An acknowledgement means awaiting native confirmation; disappearing pending entries do not prove whose response was used. The native runtime lacks a compare-and-swap reply API; local revalidation cannot remove that upstream race.

Cancellation requests retain occupancy until stopped execution is proved. **核对执行状态** can update records and release proved occupancy without sending a model turn or running verification. **恢复观察** may finish existing verification or use a qualified remaining bounded busy continuation. No force-stop, force-unlock, account rotation, workspace merge or cleanup command is supplied.

Historical file Diff reads registered immutable artifacts and verifies all bytes and hashes. It never substitutes current workspace files. It is cumulative relative to the workspace base commit. Nonignored untracked files appear separately from the Git patch; binaries, missing legacy snapshots and files above the 2 MiB editor limit have explicit limitations. A local reviewed marker binds authority, pool/store, task and manifest hash; it changes no daemon state.

## Development

From the repository root, run `npm --prefix extensions/vscode ci` and `npm --prefix extensions/vscode run build`. F5 defaults to **Mock UI (no daemon)**. Development-only environment variables select an in-memory validated fixture; mock failures never fall back to real connections. The second F5 profile merely preselects a real pool; Connect remains explicit. Choosing a new connection directory or changing host Settings overrides the initial F5 directory without a restart. Production ignores all debug environment variables and excludes fixtures.

Use `test:unit`, `test:integration`, `test:smoke` and `test:browser` for the separate checks. Electron smoke requires a desktop/Xvfb session and downloads official VS Code test binaries. `package:vsix` builds the bundle; `package:check` inspects the allowlisted archive. These default tests send no real model request.

`test:real-model` is a separate opt-in acceptance runner and skips before any connection unless `ZCODE_POOL_RUN_REAL_MODEL=1`. An enabled run also requires explicit `--pool-home`, `--worker-id`, `--workspace-id`, `--prompt-file`, `--verify-commands-file`, `--model-id`, `--mode`, `--session`, `--busy-retry-limit` and a new `--receipt-file` path. The verification file is a JSON array of `{command,args,timeoutMs}` objects. It dispatches once and observes the original task; approvals remain a manual UI action. It never automatically approves, probes, resumes, cancels or retries. Default build, F5, smoke and CI paths do not enable it.

日常收工可用“收工：停止实例与后台”，有任务占用时拒绝，数据保留。“断开面板”仅停止观察。MCP 通过 `zcode_daemon_start` 明确启动，通过 `zcode_shutdown_pool` 收工；查询不会重启后台。旧后台需在空闲时升级后提供收工能力。

## Icons

Webview and command icons use [VS Code Codicons](https://github.com/microsoft/vscode-codicons) (© Microsoft, CC BY 4.0) so the workbench matches native VS Code glyphs. `media/icon.png` is rendered from `media/icon-source.svg`; `media/zcode-pool.svg` is the monochrome 24×24 activity-bar mark.
