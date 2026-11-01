# 中断、重新附着与审批

[开发与运行](development.md) · [架构设计](design/architecture.md)

重新附着恢复的是已有原生回合的观察连接，不重新发送状态未知的命令。唯一的自动新回合例外是：确认当前回合因模型繁忙失败、没有活动执行且满足次数与身份约束时，在原会话立即发送“继续”。详见 [繁忙自动续跑](busy-recovery.md)。恢复不重启 Worker 或刷新账号。

## daemon 启动后的行为

获得本地单实例所有权后，daemon 先把上次未完成的 dispatching、running、waiting_approval、verifying 任务记为 interrupted，再对仍持有占用的任务尝试一次恢复。启动不会等待所有原生连接完成，因此 overview 可能先显示 interrupted，再显示恢复后的状态。

恢复要求已持久化原生 sessionId，并同时核对：

- Worker 的现有进程和端点可由 supervisor 验证；恢复不启动 Worker。
- `openSession` 传入既有 sessionId，不传模型或模式配置。当前适配器对此只订阅既有会话，不创建会话或修改配置；返回的 sessionId 和工作区路径仍须匹配。
- 新连接的原生快照中恰有一个 `sourceCommandId` 等于当前尝试的命令 ID（首次为 requestId） 的 turnHeader，且具有产品 turnId。
- 活动回合必须是 running，且唯一 activeWork 的 sourceCommandId 等于原命令；activeWork 提供 turnId 时也必须一致。终止回合则要求原回合为 completedSuccess、failed 或 completedInterrupted，且 activeWorks 为空。

缺少会话标识、历史尾部不包含原回合、身份冲突、其他回合仍活动、Worker 不可达时，返回 requiresInspection 和固定控制原因，保留任务、Worker 和工作区占用。原生错误文本不放进默认恢复响应。没有持久化派发意图的任务可证明从未发出，会释放占用，且不会重新派发。

恢复只做一次；事件流再次中断后仍保留未知占用，没有无限重连或重发循环。需要时可显式重试订阅：

```bash
npm run cli -- resume_task '{"task_id":"替换为taskId"}'
```

该方法也可以恢复 ACK 丢失但已保存 sessionId 的任务；有续跑记录时核对持久化的当前命令 ID，而非最初的任务 requestId。并发 resume/reconcile 会按任务串行；已有运行或核验操作不会启动第二个完成链路。

## 结果、核验与占用

安全确认原回合成功终止且尚未开始过核验时，resume_task 会进入 verifying，运行该任务原先配置的本地核验命令并生成现有格式的不可变 diff/未跟踪文件快照；未配置命令时仍只有 `git diff --check`。核验和快照全部完成前一直持有工作区占用。非繁忙的原生失败不自动重试，原生取消需观察到终止才能释放占用。

如果任务以前进入过 verifying，daemon 崩溃或后续完成步骤失败后，恢复拒绝重跑核验或直接释放占用。判断使用持久事件，不依赖可能被后续恢复说明替换的 detail。原因是本地核验命令可能有副作用，也可能留下仍运行的子进程。当前没有强制解锁或核验重试接口；此类任务需人工检查本地进程和工作区，不能把原生模型已停止等同于所有本地操作已停止。

`reconcile_task` 保留只读对账含义：既未附着也未开始过核验的任务，在确认原命令终止且无活动执行后，可记录未核验结果并释放占用。它不运行配置命令，不生成已核验成功结论。已附着任务或正在完成的任务只返回当前控制状态。中断的核验同样不会被它强行解锁。

daemon 正常关闭会先拒绝新的协调请求、关闭观察连接并等待已开始的本地核验结束，再释放 socket 和所有权锁。这样后继 daemon 不会与旧核验进程同时写状态或工作区。SIGKILL 无法等待，因此仍适用上述保守核验恢复边界。

## 恢复审批和取消

重新附着会保留 waiting_approval，返回有界审批预览、approvalId、pendingApprovalCount 和可供 `get_logs` 使用的 approvalLogCursor。摘要最多 384 UTF-8 字节；大参数截断不会丢失审批 ID。预览标记 reviewComplete:false；需要按需查看持久审批事件及完整的本地原生审批详情，不能把短摘要当成完整审批依据。

只允许响应可以通过 sourceCommandId、产品 turnId 或原任务行的 anchorRowId 归属到该任务的审批；身份有冲突时拒绝。无法归属的会话级审批需要本地复核。blocked/invalid/cooling 账号只恢复观察和取消，不允许通过 accept 审批绕过账号状态。

```bash
npm run cli -- respond_approval '{"task_id":"替换为taskId","approval_id":"替换为approvalId","decision":"accept"}'
npm run cli -- cancel_task '{"task_id":"替换为taskId"}'
```

回应一个审批后会重新读取原回合的 pending interactions；仍有其他审批时保持 waiting_approval 并展示下一个审批。原生 ACK 早于移除该审批的订阅更新时，保持 pending 并标记 awaitingNativeRevision/approvalResponsePending，后台只读检查该更新，不重复发送回答或自动批准其他审批。

缺少实时附着时，respond_approval 和 cancel_task 可以先尝试同样安全的原回合重新附着。取消请求的 ACK 仍不是终止证明。无法证明原回合身份或缺少原生定向停止信息时拒绝取消，绝不停止另一个后续回合。stop_worker 在存在活动或未知占用时继续拒绝。

## 输出边界和验证范围

恢复响应只含任务控制状态、有界审批预览和核验状态，不返回原生 raw 历史。恢复事件泵从检查过的初始快照 cursor 后开始，避免把旧会话内容自动重放成任务输出。结果摘要仅取匹配原回合的 assistantText；历史窗口不完整时宁可为空。

本地测试覆盖带假原生连接的身份冲突、审批归属、取消确认、并发恢复、一次完成，以及真实 daemon 子进程的 SIGKILL 重启、重新附着和关闭期间保留所有权。测试没有启动真实模型或修改外部默认实例，不等同于所有真实服务状态都能恢复；原生快照仍只是尾部窗口。
