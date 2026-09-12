---
title: "OpenSandbox 源码走读（五·收官）：踩坑合集——3s 轮询、execd 限制与风险清单"
slug: opensandbox-5-pitfalls
description: "OpenSandbox 源码走读收官篇：3s 轮询、execd 限制等踩坑点的源码定位，以及一份使用风险清单。"
date: 2026-09-06T20:11:17+08:00
lastmod: 2026-09-06T20:11:17+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories:
    - 技术笔记
    - kubernetes
tags:
    - opensandbox
    - k8s
    - sandbox
    - ai-agent
image: https://picsum.photos/seed/441fa0fb/800/600
---
# OpenSandbox 源码走读（五·收官）：踩坑合集——3s 轮询、execd 限制与风险清单
------
> 系列最后一篇，不讲架构，专讲坑。调研和使用 OpenSandbox 过程中踩过、或者差点踩到的坑，按"现象 → 定位 → 根因 → 对策"整理成独立小节，可以直接当 checklist 用。

## 3s 轮询：任务调度的来龙去脉
------
> 这是我在这套代码里最重要的一个发现：批量任务型 sandbox 的整个调度闭环，是被一个写死的 3s 周期推着走的。

先看代码，`kubernetes/internal/controller/batchsandbox_controller.go`：

```go
func (r *BatchSandboxReconciler) reconcileTasks(
	ctx context.Context,
	batchSbx *sandboxv1alpha1.BatchSandbox,
	pods []*corev1.Pod,
) (*taskScheduleResult, error) {
	...
	// Because tasks are in-memory and there is no event mechanism, periodic reconciliation is required.
	DurationStore.Push(types.NamespacedName{Namespace: batchSbx.Namespace, Name: batchSbx.Name}.String(), 3*time.Second)
	...
}
```

注释说得很直白：task 是控制器进程内的纯内存对象，没有任何事件机制，所以只能周期性 reconcile。每 3 秒一轮，干三件事：

```
每 3s 一轮 Schedule():
  1. refreshFreePods()      重建空闲 pod 列表（一个 pod 同时只跑一个 task）
  2. collectTaskStatus()    并发 GET http://<podIP>:5758/getTasks 拉任务状态
  3. scheduleTaskNodes()    分配空闲 pod + POST /setTasks 下发任务 / 释放资源
```

**现象**：稳态下没有任何业务变化，控制器依然高频 reconcile。粗算一下，1000 个任务型 sandbox 就是稳态 333 reconcile/s，规模化后 CPU 和 API server 压力线性上涨。

**根因**：为什么不用事件驱动？我专门推演过改成 push 模式的可行性，结论是当前设计下很难：

| 约束 | 说明 |
|---|---|
| 归属路由 | taskScheduler 在控制器内存里，pod 内的 task-executor 根本不知道该上报给哪个实例（leader 还会切换） |
| 可靠性 | 上报会丢（控制器重启/网络抖动），需要 ack/重试/补偿；轮询天然幂等 |
| 调度动作仍需驱动 | 新任务下发、释放、删除回收都靠周期性 reconcile 推进状态机，状态上报替代不了 |

也就是说 pull 不是偷懒，是"task 状态存在 pod 内 HTTP 服务里 + 调度器在内存里"这个结构下的必然选择。3s 是"可感知粒度"的妥协——HTTP 默认超时也是 3s（`kubernetes/internal/scheduler/default_scheduler.go` 里 `defaultTimeout = 3 * time.Second`）。

**但真正的坑在放大效应**。第一处，状态收集是无界全并发，`kubernetes/internal/scheduler/status_collector.go`：

```go
func (s *defaultTaskStatusCollector) Collect(ctx context.Context, ipList []string) map[string]*api.Task {
	semaphore := make(chan struct{}, len(ipList))  // ← 容量 = pod 数，等于没有限流
	...
	s.logger.Info("Collect task status", "result", utils.DumpJSON(ret))  // ← 每轮把全部任务状态序列化打 Info 日志
}
```

第二处，Pod 事件无过滤，`batchsandbox_controller.go` 的 `Owns(&corev1.Pod{})` 没挂任何 predicate——任意 Pod 状态波动都触发整池 reconcile。第三处，`RequeueAfter` 走 `AddAfter`，**绕过了 workqueue 的指数退避限流**（限流只保护返回 error 的路径）。

**对策**：
- 这个 3s 目前改不了，只能缓解：调大 `--concurrency=batchsandbox`，把状态收集日志降到 Debug；
- 自己写集成时，任务型 sandbox 的规模要做预估算，别等 reconcile 延迟失控才发现；
- 如果要改事件驱动，可行路径是 task-executor 在任务终态写回 CR status，控制器 watch 触发 + 低频兜底轮询防丢——但代价正是现在这套设计刻意规避的 API server 写放大。

> 说实话我一开始以为这是个能顺手修掉的"缺陷"，读完整个调度链才发现它是结构性的：内存态调度器 + pod 内 HTTP 状态源，这两个决定摆在那，轮询就是唯一自洽的方案。要根治得动数据流，不是改个时间常数的事。

## execd 目录列表：六个限制一次说清
------
> 插件场景（通过 execd 读沙箱内文件系统）最容易在这里翻车，尤其是大目录。

接口是 execd 的 `POST /directories/list`，契约在 `specs/execd-api.yaml`，实现全在 `components/execd/pkg/web/controller/filesystem.go`。六个限制，逐个对应代码：

**1. depth 默认 1，depth=0 返回空数组**

```go
depth := 1
if rawDepth := c.ctx.Query("depth"); rawDepth != "" {
	parsedDepth, err := strconv.Atoi(rawDepth)
	if err != nil || parsedDepth < 0 {
		c.RespondError(http.StatusBadRequest, ...)  // ← 负数/非数字直接 400
		return
	}
	depth = parsedDepth
}
```

```go
func listDirectoryEntries(root string, maxDepth int) ([]model.FileInfo, error) {
	entries := make([]model.FileInfo, 0, 16)
	if maxDepth == 0 {
		return entries, nil  // ← depth=0 不是"不限深度"，是空数组
	}
	...
}
```

第一眼看 `depth=0` 很容易理解成"不限制"，实际是返回空。想递归列全树只能一层层调。

**2. 符号链接不穿透**。root 是 symlink 直接拒绝：

```go
// Use Lstat so a symlink passed as the root is detected and rejected
// rather than silently followed
info, err := os.Lstat(path)
...
if info.Mode()&os.ModeSymlink != 0 {
	c.RespondError(http.StatusBadRequest,
		fmt.Sprintf("path is a symbolic link, refusing to traverse: %s", path))
	return
}
```

遍历过程中的 symlink 只作为条目列出，不递归展开。`/workspace` 这类 symlink 路径会直接 400，要传真实路径。

**3. 必须是目录**：传文件路径 400，路径不存在 404。

**4. 没有路径白名单**：`ExpandAbsPath` 会展开 `~` 等，execd 以 root 跑在沙箱内，整个容器文件系统都能列（安全边界只剩容器本身的挂载视图）。

**5. 没有数量/大小上限**：`listDirectoryEntries` 递归无任何截断。列 `/usr`、`node_modules` 这种目录会返回巨大 JSON，撑爆响应体或客户端内存——**这是实际影响最大的一个坑**。

**6. 只返回元数据**：`FileInfo`（path/name/size/mode/is_dir/modified），不含内容，看内容要再调 read 接口。

**对策**：列目录前先用 `depth=1` 探一下规模，再按需深入；定向找文件改用 `/files/search`（支持 glob，默认 `**`，同样是 `filepath.Walk` 全量遍历、无数量上限，适合找文件而不是扫目录）。

> 第 2 条 symlink 拒绝我觉得设计是对的——Lstat 而不是 Stat，注释里明确写了理由：symlink-as-root 会暴露与调用者请求不同的子树。宁可 400 也不静默穿越，这个取舍值得学。

## controller 已知缺陷清单
------
> 这一节是我对着源码逐条核过的，每条都标注了代码位置，按"会不会咬人"排序。

**Helm 默认资源限额过小**（`kubernetes/charts/opensandbox-controller/values.yaml`）：

```yaml
resources:
  limits:
    cpu: 500m
    memory: 128Mi
  requests:
    cpu: 10m
    memory: 64Mi
```

控制器是全集群 informer 缓存（数百 MB 量级）+ 每 sandbox 调度器状态 + HTTP 轮询，128Mi 上限在批量创建/回收潮里很容易 OOM。上规模前先调大。

**缩容未实现**（`batchsandbox_controller.go`）：

```go
// TODO var needDeleteIndex []int
// TODO consider supply Pods if Pods is deleted unexpectedly
```

两行 TODO 挨在一起，覆盖了两个坑：`spec.replicas` 调小不会删 Pod（只扩不缩）；Pool 模式下分配的 Pod 被外部删掉后，`alloc-status` 注解里的 Pod 名残留，`supplement = replicas - len(allocated)` 恒为 0，**沙箱永久不可用**。节点驱逐、OOM Kill 这种规模化最常见的场景正好命中后者。

**恢复失败直接退出进程**（`kubernetes/internal/controller/allocator.go`）：

```go
// ... is terminated via os.Exit(1) because the allocator cannot operate with an ...
os.Exit(1)
```

首次 `Schedule()` 时 `Recover` 失败（全集群无选择器 List）→ 直接 `os.Exit(1)` → CrashLoop，且每次重启重试全量 List。RBAC 权限错误、API server 抖动都会触发，恢复逻辑没有降级路径。

**pause 只支持单副本**（`batchsandbox_pause_resume.go`）：

```go
const supportedPauseReplicas int32 = 1
```

多副本请求 pause 会 ACK 回原 phase + `PauseFailed(UnsupportedReplicas)`。和"缩容未实现"组合成死锁：想 pause 多副本 → 得先缩到 1 → 缩不了。

**每 pod 串行执行**（`kubernetes/internal/task-executor/manager/task_manager.go`）：

```go
maxConcurrentTasks = 1
```

一个 pod 同时只能跑一个任务，第二个直接报错。并发度完全由 `spec.replicas` 决定，任务排队只能靠扩容。

**分配状态真相源是注解，整表覆盖写**。每次分配把 pod 数组 JSON 整表 MergePatch 写 `alloc-status` 注解，并发分配时以最后一次写入为准，丢更新风险靠"先内存后注解、失败回滚"兜底。绕过内存 store 直接改注解会丢状态——注解是内部契约，别碰。

**任务下发走裸 HTTP**。调度器对 pod 内 5758 端口直连，无认证无鉴权，安全边界完全依赖 NetworkPolicy。部署时必须配。

> 这份清单里我最警惕的是缩容那条 TODO——它意味着"多副本"这个看起来很常规的能力，实际是半成品：不能缩、pause 不了、Pod 挂了不补。容量规划只能按只增不减来做。

## 风险清单：上游 open issues 里躲不掉的坑
------
> 调研时我们实际用不到 pause/resume，本来以为禁掉就能绕开一批问题。对着全部 open issues 逐个过完的结论是：绝大多数规模化风险和 pause/resume 无关，禁用也躲不掉。

**P0 级，Pool 模式的复合缺陷**（截至调研均无修复 PR）：

| Issue | 现象 | 要点 |
|---|---|---|
| #1423 | Pod 创建/删除风暴 | 每分钟创建 ~2250 / 删除 ~2290 个 pool Pod，约一半创建请求失败；重启控制器无效，~15 分钟复发 |
| #954 | 分配的 Pod 被删后永不重绑 | 上面缩容 TODO 那条的上游 issue 化，沙箱永久不可用 |
| #1433 | `poolRef` 可变更导致 in-use Pod 被杀 | CRD 无 `x-kubernetes-validations` 也无 admission webhook，运行中改 poolRef 触发破坏链且状态假报 |

#1423 有个特别阴的细节：缩容按 CreationTimestamp 升序删 idle Pod，"最旧空闲"在长启动时间下等于"刚启动完的"——正好把可服务的 buffer 删掉，留下 Pending，风暴自我维持。

**「挂了自动拉起」不存在**。上游明确 resume 只恢复有意的 Paused 状态，Terminated/Failed 不自动重启；重建 = 新 sandbox ID + 内存和未持久化状态全丢。这是集成设计的前提性结论：**业务关键状态必须外置**，"自动拉起 + 保 ID + 保状态"在当前上游语义下不可实现。

**快照作为替代方案也有坑**：带 egress sidecar（即启用 network_policy）的沙箱无法 snapshot（#1382，commit Job 对多平台 manifest 单平台化 push 失败）——几乎所有有网络隔离的真实工作负载都中招；快照删除不清理 registry 镜像（#1179），存储泄漏。

**运维侧三个必知**：

- #1386：server 运行约 1 周后 httpx 连接池耗尽（当时并发只有 1-5 也复现），长期运行建议监控连接池并周期性重启；
- #1408：server 只导出一个指标，还是 SDK 客户端上报的——不用 SDK 的部署一个指标都没有，约 40 种失败模式零计数，故障在指标层完全不可见；
- #1409：egress 的 memory/cpu 指标实际读的是节点 `/proc`，却按 `sandbox_id` 打标签，N 个沙箱 = N 条相同的节点级假序列，监控基数爆炸。

**对策压缩成五条**：不假设任何自动恢复；Pool 模式先验证 #954/#1433 修复是否合入、CR 创建后禁止改 poolRef、小 pool 固定容量；批量释放别用 SDK 串行 `releaseAllIdle`（500 个空闲沙箱 ≈ 480s，自实现 50 并发可压到 ~150s）；快照方案避开 network_policy 并自行清理镜像；server 自建指标。

## proxy 链路的业务事实
------
> 我们的业务里所有沙箱流量都走 server proxy，这一节是把 proxy 的行为事实单独拎出来，集成时逐条对过。

连接拓扑：

```
业务 / SDK（use_server_proxy=True）
  │  create / delete / renew-expiration（lifecycle API，直连 server）
  │  exec / 文件 / 健康检查（execd API，经 proxy 转发）
  ▼
OpenSandbox Server
  ├── proxy（/sandboxes/{id}/proxy/{port}/）──► 沙箱 execd（默认 44772）
  └── renew_intent consumer（proxy 访问触发自动续约）
```

每次 proxy 转发前依次执行（`server/opensandbox_server/api/proxy.py`）：解析沙箱内部端点 → secure-access token 校验（启用时缺头 401/403）→ 提交自动续约信号（非阻塞）→ 转发。

**自动续约的生效条件**，四个必须同时满足：服务端 `[renew_intent] enabled = true`；沙箱创建时 opt-in（`extensions["access.renew.extend.seconds"]` = 300~86400）；沙箱 Running；有过期时间。语义是 `new_expires_at = max(now + extend.seconds, current_expires_at)`，单调不减、幂等。

**容易踩的边界**：

1. **端口必须已暴露**：proxy 只对创建沙箱时暴露的端口生效，execd 的 44772 没暴露就是 404/502；
2. **runtime-id 门禁**：pod 被重建后旧 id 返回 409 RUNTIME_REPLACED，调用方要按响应里的 `runtime_id` 切换，这个 409 实际是"环境已重置"的信号；
3. **伪永久沙箱不续约**：创建不传 `timeout` 则 `expiresAt=null`，永不自动终止，自动续约机制完全跳过；反过来过期了的沙箱想用 renew-expiration 补时间也是 409——TTL 是单向的；
4. **HTTP 的 `Upgrade: websocket` 会 400**，WebSocket 走 proxy 的独立路由；
5. **敏感 header 不转发**：`authorization`/`cookie` 会被剥掉。

我们的选型结论：池化会话走**伪永久 + 上层主动删除**，不 opt-in 续约，业务 delete 时由中间层 postStop 兜底回写状态；需要"空闲回收"兜底时才改 TTL + opt-in，让活跃会话经 proxy 自动续命。两条路径都不需要 Redis（proxy-only 模式本地冷却就够）。

> proxy 这个设计我比较欣赏的是续约信号的放置位置：挂在每次转发的必经路径上、非阻塞提交，活跃会话自然续命，不活跃自然过期——业务侧完全无感。缺点是多副本部署时可能重复续约（好在幂等，无害）。

## 结
------
把全系列五篇的坑浓缩成一张最终 checklist：

```text
[ ] 任务型 sandbox 规模预估算过 3s 轮询的 reconcile 压力了吗
[ ] 列大目录前先 depth=1 探了吗；symlink 路径换成真实路径了吗
[ ] Helm 限额（128Mi/500m）按实际规模调过了吗
[ ] 接受"缩容未实现、Pod 挂了不补"了吗（容量只增不减）
[ ] 业务关键状态外置了吗（自动拉起不存在，重建 = 新 ID + 丢状态）
[ ] Pool 模式验证过 #954/#1433 修复了吗；poolRef 锁死了吗
[ ] NetworkPolicy 配了吗（task 下发是裸 HTTP）
[ ] server 自建指标了吗（自监控约等于零）
[ ] 长期运行的 server 有 httpx 连接池监控吗
```

> 五篇走读到这收官。从 controller 的 reconcile 闭环、lease 生命周期与续约、池化的模板/注入/S3 会话同步、出口网络的策略与池化出口，最后落到这篇的坑清单——我对 OpenSandbox 的整体判断没变过：架构思路（池化 + 内存态调度 + 注解契约）足够轻快，但工程完备度和它宣传的生产可用之间还有明显距离，规模化路径上的每一个坑几乎都指向同一个根源：内存态 + 无事件机制 + 无界结构。用它，就得按它的真实边界来设计，而不是按文档承诺来设计。
