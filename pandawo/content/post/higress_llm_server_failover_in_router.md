---
title: "Higress 网关 LLM 端点故障临时屏蔽（Endpoint Failover）"
slug: "higress_llm_server_failover_in_router"
description: "Higress ai-load-balancer 端点软屏蔽：连续失败进冷宫、全屏蔽软回退、失败次数与时间点可观测"
date: 2026-08-01T23:44:36+08:00
lastmod: 2026-08-01T23:44:36+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic:
categories: ["技术笔记"]
tags: ["higress", "llm", "wasm", "golang"]
image: https://picsum.photos/seed/1ba03f14/800/600
---

# Higress 网关 LLM 端点故障临时屏蔽（Endpoint Failover）
------
> 给 LLM 网关做选端的时候碰到一个绕不开的问题：供应商端点的故障大多是"业务性"的——429 限流、配额耗尽、5xx，连接层完全正常，Envoy Outlier Detection 这种平台健康检查根本发现不了。所以在 ai-load-balancer 选端前加了一层黑名单过滤器：失败端点暂时打入冷宫，惩罚期过了再放回候选池。整个设计最核心的理念是软屏蔽——被屏蔽不等于不可用，只是低优先级。

## 需求拆解
------
LLM 端点故障和普通微服务不一样：故障持续时间从几十秒到几分钟，期间所有请求都挂在超时上；同一个集群里 A 挂了，B、C 还活着，需要快速改道；429 限流是常态而不是异常，但连续 429 说明端点已经过载。

需求拆出来五条规则：
- R1 只有上游真实响应才算失败（网关自己拦的不算）；
- R2 连续失败 ≥ 阈值进屏蔽名单，窗口内不参与选端；
- R3 过滤后候选集为空 → 不覆盖端点，走 Envoy 默认选端；
- R4 候选集非空时按负载策略从候选集选最优；
- R5 TTL到期惰性恢复，可选健康检查加速。

> R3 是这个设计最反直觉的地方。多数熔断在"全被屏蔽"时会直接吐 503，这里把控制权还给 Envoy 默认路由。我认同这个取舍：网关的职责是转发，不是裁决。宁可流量打到可能已恢复的端点，也不主动拒绝。

## 核心流程
------
一条请求走四个阶段：请求头阶段 `DisableReroute()` 锁死路由，保留选端控制权；请求体阶段拿到 `GetUpstreamHosts()` 的健康端点，过滤屏蔽名单；响应头阶段判定成败；流结束阶段兜底。

```text
请求头   DisableReroute() 锁死路由，保留选端控制权
请求体   GetUpstreamHosts() → 过滤健康端点
         → 读屏蔽名单（本地缓存 1s TTL，过期才拉 SharedData）
         → candidates = healthy − blocked
         → 空？不覆盖走默认（R3） ｜ 非空？按策略选最优并覆盖
响应头   IsResponseFromUpstream() 且命中失败码 → 计数 +1
         → 连续失败 ≥ 阈值 → 写屏蔽名单（blockUntil = now + 60s ± 抖动）
流结束   正常结束清零计数；异常断流按失败处理
```

选端放在请求体阶段是关键：在建立上游连接之前就把坏端点过滤掉，故障的代价从"超时级"降到"选端级"。失败判定放在响应头阶段，此时请求已结束，不增加时延。

## 状态机：端点怎么被"打入冷宫"
------
以 consecutive 模式（阈值 3、屏蔽 60s）为例：

```text
T0      正常，FailCount=0
T1      503 → FailCount=1
T2      503 → FailCount=2
T3      503 → FailCount=3 → 触发！BlockUntil = now + 60s + 随机±6s，计数清零
T4~T63  选端时在屏蔽名单里，跳过
T63+    到期，惰性恢复，回到候选池
```

触发判定核心就几行：

```go
if b.FailCount >= failureThreshold {
    b.BlockUntil = now + blockDurationMs + jitter() // ← 抖动防同步解封
    b.FailCount = 0                                 // 恢复后从零重新计数
}
```

> 触发后清零 FailCount，这个细节我琢磨了一下：不清零的话，历史失败会一直累积，端点永远达不到新阈值，等于屏蔽一次就永久拉黑。但清零也带来盲区——间歇性抖动（偶发 429 后连续成功）永远不会触发，所以设计里还有 window 触发模式（60s 内失败 ≥ 5 次）和 rate 模式（窗口失败率 ≥ 50%）补这个洞。

两个实现细节值得展开：

**CAS 并发安全**。wasm 每个 worker 一个 VM，多个 VM 可能同时判定"该屏蔽 A"。屏蔽状态必须走 `GetSharedData → 修改 → SetSharedData(cas)` 原子循环，冲突重试上限 10 次，超限降级为本地计数。这套模式在 ai-proxy 的 apiToken failover 里已经跑过一遍，代码直接复用。

**本地缓存 + TTL**。热路径上每请求读一次 SharedData 撑不住，每个 VM 缓存屏蔽名单快照（默认 1s TTL），选端时直接用内存副本。代价是屏蔽生效有最多 1s 延迟——性能和生效速度的权衡，对企业场景是合理折中。

## 软屏蔽：全被屏蔽时不覆盖
------
选端逻辑压成一行公式：

```text
candidates = GetUpstreamHosts().healthy − blocked
selected   = LoadBalancer.Select(candidates)
```

候选集非空 → 按 least_busy / global_least_request / prefix_cache 从候选集里选最优；候选集为空 → 不调 `SetUpstreamOverrideHost`，Envoy 默认路由接管，流量仍可能打到被屏蔽端点。

软屏蔽带来三个收益：全死锁时至少还有流量能过去；刚恢复的端点能立即承载流量；屏蔽判定有误时，流量不会被完全阻断。思路和 Envoy Outlier Detection 的硬剔除（全剔除时也回退）一致，但 wasm 层能叠加业务规则——比如按 model 维度屏蔽：端点 A 的 qwen-max 稳定但 gpt-4 超配额，只屏蔽 gpt-4。

> 一个没想通的地方：候选集为空时流量均匀撒向所有端点（包括坏的），失败率保持高位，直到某个端点恢复。设计没有做"全屏蔽时按最近成功率挑一个最可能活的"这类优化。可能因为收益不确定，不值得为极端场景加复杂度。

## 失败判定：网关的拦截不算数
------
R1 是最容易踩坑的地方：

```go
if !wrapper.IsResponseFromUpstream() {  // 网关自己拦的不算
    return types.ActionContinue
}
```

waf 拦截的 403、限流返回的 429、管理接口的响应，都是网关自身行为，不是上游真实反应。把这些计入失败，健康端点会被误判成故障。

设计文档点出一个更隐蔽的问题：插件执行顺序会让 `IsResponseFromUpstream()` 不可靠。限流插件如果在 failover 之后执行，限流 429 从 failover 视角看就是"来自上游"。对策是让限流插件注入 `X-Rate-Limited: true` 头做二级判定；健康检查子请求也要打标记跳过判定，否则探活请求的 503 会不断延长屏蔽时间，端点永远无法恢复。

> 判定污染在插件体系里很常见：每个插件只看到自己阶段的响应，不知道响应是别人伪造的。用响应头标记做显式契约，比赌执行顺序可靠。

## 恢复机制：不引发二次故障
------
恢复期最容易出事——所有端点同时解封 → 瞬时过载 → 再屏蔽，形成同步震荡。设计里堆了几层防护：`blockUntil` 加随机抖动（±10%）打散解封时刻；健康检查需连续成功 ≥ successThreshold 次防振荡；租约选主只让一个 VM 发探活，最小模型降成本；可选指数退避，连续多次屏蔽时窗口倍增 60s→120s→240s。

恢复有两条路径：惰性恢复零成本但最慢，等 60s 自然到期；主动健康检查用最小模型发探活请求，连续成功就提前解封，代价是额外计算资源。

> 惰性恢复的实现是"选端时发现过期即清除"，不需要任何定时器，恢复完全被请求驱动。这个设计我喜欢，零开销。

## 观测设计
------
需求明确要求"完整支持失败次数与时间点的可观测性"，四路输出：Prometheus 指标（Counter 累计失败/屏蔽/恢复，Gauge 实时状态/剩余时间，Histogram 屏蔽时长）、访问日志（endpoint_selected、endpoint_blocked、endpoint_fail_count）、链路 span 标签、admin 查询接口（`/_internal/_higress/endpoint-failover/status` 返回 JSON）。

数据模型上，每个端点维护：连续失败数、累计失败数、滑动窗口失败事件序列（上限 20 条），外加最近失败/成功/进入屏蔽/到期/恢复五个时间点。剩余屏蔽时间、失败率这类派生指标不存储，查询时现算。

观测后端可配置。Prometheus 方案是 VM 本地指标，跨实例靠采集端聚合；Redis 方案复用限流插件已有的 RedisClient，ZSet 存事件流（score=时间戳），跨 VM 跨实例天然一致，管理接口直接读 JSON，不用 PromQL。

> Redis 方案能覆盖 Prometheus 的全部观测语义，差别只在"谁来看"——Prometheus 由采集端拉取，Redis 由查询接口消费。对没有 Prometheus 基础设施的企业，Redis 反而是更省事的选项。

## 与现有能力的分层
------
这个设计不是孤岛，和企业网关已有的能力叠成五层：

```text
第 1 层：连接/传输健康   Envoy Outlier Detection（平台级，硬剔除） —— 管"连不上"
第 2 层：业务健康判定    ★ 端点软屏蔽（本设计）                   —— 管"业务异常/限流"
第 3 层：请求重试        ai-proxy retryOnFailure（换 token 重试）  —— 管"单请求偶发失败"
第 4 层：认证可用性      ai-proxy apiToken failover（token 隔离）  —— 管"key 失效"
第 5 层：容量保护        ai-token-ratelimit / ai-quota            —— 管"超卖"
```

本设计管"换端点"（这个后端坏了换那个），ai-proxy 的 failover 管"换 token"（这个 key 没额度了换那个），两层正交可叠加。端点全挂时，ai-proxy 的重试自然兜底。

> 分层的关键是别重复实现平台已有的能力。连接级健康判定交给 Envoy，这里专注 LLM 业务语义——429、配额耗尽、业务错误码，这些平台健康检查永远管不到。

## 边界情况：踩过的坑提前排雷
------
设计文档列了十几个 Bad Case，挑几个有代表性的：

| Bad Case | 根因 | 预防 |
|---|---|---|
| 限流 429 误判为上游故障 | `IsResponseFromUpstream()` 受插件执行顺序影响 | 限流插件注入 `X-Rate-Limited` 头 |
| 健康检查自身触发熔断 | 探活请求的 503 进入失败判定，屏蔽无限延长 | 健康检查请求打标记，跳过判定 |
| 单端点集群死锁 | 唯一端点被屏蔽后请求全打它，失败又延长屏蔽 | 单端点时不延长 BlockUntil |
| 熔断误伤无法恢复 | 误配 `failoverOnStatus` 导致全端点被屏蔽 | Admin 接口 `unblock` / `unblock-all` |
| Redis 分区后本地不一致 | 各 VM 独立判定，屏蔽状态分裂 | 本地模式降阈值 + 短屏蔽时间 |

贯穿始终还有两条原则：一是 fail-open，`GetUpstreamHosts` / `SetSharedData` 任一出错就记日志走默认路由，熔断自身故障不能阻断流量；二是可回滚，`enabled: false` 热更新即全量直通，`failoverOnStatus: []` 让失败判定永不触发，已有屏蔽自然到期。

## 总结
------
把"换端点"做成可观测、可回滚、fail-open 的特性，而不是在 ai-load-balancer 里硬编码一个熔断。但离开箱即用还有距离：本地缓存一致性窗口、CAS 写放大、Redis 故障降级，这些参数需要在自己环境中靠压测和灰度慢慢调。

如果要上生产，需要多关注三个点：多副本网关下 SharedData 只覆盖单实例，所以靠不住，屏蔽状态全局一致得靠 Redis；window 触发模式的失败事件序列存 SharedData 做 CAS 更新，跨 VM 竞争比单纯计数激烈得多，也许把窗口判定直接交给 Redis 的 `ZCount` 才是正解；上线前对 `failureThreshold` / `blockDurationMs` 做灰度验证，误配 `failoverOnStatus` 的代价是全端点被拉黑。甚至可以考虑在上述设计逻辑中为特殊的上游端点配置白名单，可以是从缓存里面拿去，或者是从按配置的正则来匹配
