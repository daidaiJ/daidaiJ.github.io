---
title: "Higress 端点级断路器（一）：本地 Provider 的端点屏蔽与 TTL 控制"
slug: higress-endpoint-breaker-ttl
description: ""
date: 2026-09-06T19:59:22+08:00
lastmod: 2026-09-06T19:59:22+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories:
    - 技术笔记
    - ai
tags:
    - higress
    - llm
    - gateway
    - 断路器
image: https://picsum.photos/seed/bdbb9d5f/800/600
---
# Higress 端点级断路器（一）：本地 Provider 的端点屏蔽与 TTL 控制
------
> 上游换成私有化部署的 LLM 端点之后，故障形态变了：不报 429、不吐 5xx，就是慢——请求挂在网关上几分钟才吐结果，用户早走了。这篇记录我基于 ai-load-balancer 做的一层端点级断路器：响应耗时持续突破阈值（2~3 次确认）就把端点拉黑，TTL 30~60s 到期自动放回负载均衡池。整套设计里我最满意的是统计层的 5s 去重间隔——同一端点短时间内只计一次，既防高频请求重复统计，也配合确认次数把一次抖动挡在误判之外。

## 动机：慢节点拖尾是私有化部署的特有痛点
------
之前写过[一篇](/p/higress_llm_server_failover_in_router/)处理 Higress 网关的端点故障屏蔽，针对的故障是"显式"的：429 限流、配额耗尽、5xx——响应码摆在那，数数就能判定。这次场景换成本地/私有化部署的 provider，玩法完全不同。

私有化 LLM 端点的典型故障是"慢"：

- 长上下文推理本身就可能跑几十秒，正常和异常的边界很模糊；
- 某台机器显存碎片、批处理排队、GPU 降频，服务还活着，就是越来越慢；
- 这些端点经 McpBridge 注册成 Envoy cluster（命名形如 `outbound|443||provider.dns`），连接层完全正常。

麻烦在于平台现有的健康机制全都够不着这类故障。Envoy 原生的 active health check 和 outlier detection 是设计文档里定义的 Level 1 容错，它的局限写得很清楚：只在"节点全挂/被驱逐"时起作用，429 配额耗尽、单 provider 部分降级触发不了。慢节点比这更隐蔽——consecutive_5xx 数不出来，因为根本没有 5xx，只有漫长的等待。

> 一台慢节点拖着不做处理，代价是拖尾：每个打到它的请求都白占一个网关连接槽位，挂到客户端超时为止。网关的连接池、下游的并发额度，都在替一台病机器买单。

## 端点粒度 vs 路由粒度：为什么不上现成的 failover
------
第一反应是找现成能力。盘点下来三层，粒度从粗到细：

| 层 | 机制 | 粒度 | 为什么不够 |
|---|---|---|---|
| 平台层 | Envoy outlier detection / health check | 节点 | 只认连接错误和 5xx，慢故障不可见 |
| 路由层 | ai-proxy 的 providers failover（failoverOnStatus） | provider 整机 | 切换粒度是整个 provider，且 failover 重发请求有 body 丢失的老 bug（issue #3531） |
| 选端层 | ★ 本设计的端点断路器 | 单个端点 | — |

路由层整机 failover 不适用的根本原因是场景：私有化部署里一个 provider 后面挂的是自己机房的多台推理机，没有"备用 provider"可切。慢一台就把整个 provider 判死，等于自断服务。正确的粒度是把坏的那台端点摘出去，其余继续扛流量。

选端层做这件事有个天然优势：判定发生在建立上游连接之前。ai-load-balancer 的三种 LB 策略都走同一条路——先拿候选端点集合，再指定 host 转发：

```text
GetUpstreamHosts()          // fork 扩展：读 cluster 的端点与健康状态
    → 过滤屏蔽名单           // ← 断路器插在这里
    → SetUpstreamOverrideHost(host)   // 指定端点转发
```

坏端点在选端阶段就被跳过，故障代价从"一次 70s 超时"降到"一次内存查询"。

但选端层也有自己的代价，两条 wasm 侧的硬约束：

1. `GetUpstreamHosts` / `SetUpstreamOverrideHost` 是 higress fork SDK 的扩展能力，不在标准 proxy-wasm ABI 里；
2. `SetUpstreamOverrideHost` 指定端点时**必须返回 `HeaderStopIteration`**，否则 override 不生效——这是 ai-load-balancer 三种 LB 策略验证过的统一姿势。

> 粒度选择本质上是"谁能看见故障"的问题。平台层只看得见连接，路由层只看得见 provider，只有选端层同时看得见端点和业务耗时。看得见，才管得了。

## 统计层：5s 去重窗口是整个设计的核心
------
断路器需要统计每个端点的响应表现。最朴素的实现是每次上游响应都计入统计，但这里有个私有化场景特有的陷阱：**慢端点会同时拖住一批在途请求**。

推理请求耗时本来就长，网关上同一个端点常态挂着几十个在途请求。一旦它开始变慢，这批请求会在相近的时间窗内相继超时。不去重的话：

- 一次慢抖动被记成 N 份"失败证据"，统计被同一事件重复灌水；
- 屏蔽状态走 SharedData（CAS 写），计数爆炸直接放大写竞争；
- 观测指标失真——看起来"失败了 40 次"，其实是一个慢节点拖住的一批受害者。

所以统计层加了去重间隔：**短时间内（5s）同一端点只计算一次**。设计推演如下（伪代码，非最终实现）：

```go
// 伪代码：响应统计 + 去重 + 拉黑判定
const (
    dedupWindowMs = 5000   // 5s 去重间隔
    slowThreshold = 70000  // 慢阈值 70s
    confirmCount  = 2      // 确认次数阈值，2~3 次按场景调
    blockTtlMs    = 45000  // 拉黑 TTL，30~60s 区间内取值
)

func onUpstreamResponse(ep string, costMs int64) {
    now := nowMs()
    st := stats[ep]
    if now-st.lastCountedAt < dedupWindowMs {
        return                 // ← 间隔内已计过，这个响应不重复入账
    }
    st.lastCountedAt = now
    if costMs >= slowThreshold {
        st.count++
        if st.count >= confirmCount {
            block(ep, now+blockTtlMs)   // 慢样本攒够确认次数，拉黑
        }
    }
}
```

去重带来的第二个收益是防抖动放大误判。没有窗口时，一次网络抖动产生的整批慢响应会被当成多次独立证据，叠加起来很容易越过判定边界；有窗口后，统计的时间分辨率被限制在 5s，抖动只能贡献一个样本，持续性的慢才会持续入账。顺带它还保证了确认次数之间的**最小采样间隔**——2~3 次确认至少跨过 5~10s 的观察期，"一次抖动"和"持续变慢"在这个尺度上被区分开。

多 worker 的一致性问题也要面对。wasm 插件每个 Envoy worker 线程一个 VM，跨 worker 状态不互通——统计视角天然分片，这反而可以接受（每个 worker 是一个独立采样点）；但屏蔽名单必须全局一致，否则 A worker 拉黑了、B worker 还往坏端点上发请求。跨 VM 的写要走 `Get/SetSharedData`（CAS），SDK 的语义是并发写同一 key 返回 `ErrorStatusCasMismatch`，计数器/状态必须做 Get+Set 重试循环，不能假设一次成功。

> 我考虑过把去重窗口也放 SharedData 做全局一致，后来放弃了：窗口状态是高频热路径，每次响应都 CAS 一轮，写竞争的代价超过收益。5s 窗口本身对精度不敏感，per-worker 各自维护，采样视角还更分散——这算是我为数不多主动选择"不一致"的地方。

## 阈值与 TTL：70s 慢阈值 × 2~3 次确认，30~60s 拉黑
------
判定逻辑压成一句话：耗时突破 70s 的慢样本，按 5s 去重间隔计数，攒够 2~3 次确认就拉黑；拉黑不是永久的，TTL 到期自动恢复参与负载均衡。

70s 这个数的来源是私有化场景的两头挤压：下限要高于正常推理的长尾——长上下文请求跑三四十秒是常态，阈值太低会把慢请求误判成慢节点；上限受交互式体验约束——LLM 场景用户对首字延迟的容忍就是几十秒的量级，一个响应要 70s 的端点，对用户来说和挂了没有区别。

确认次数定在 2~3 是第三个旋钮：只确认一次，一次长尾抖动（provider GC、瞬时批处理排队）就会误杀健康端点；要求太多次，慢节点又会在池里白吃好几分钟流量。2~3 次配合 5s 去重间隔，等效于要求"慢状态持续 10~15s 以上"才动手——误杀率和反应速度都被框在了可接受区间。TTL 取 30~60s，则是在"别把暂时过载的节点锁太久"和"别让真坏节点频繁回来试"之间取的平衡。

时间线长这样：

```text
T+0s      请求 A → 端点 E，开始推理
T+70s     A 耗时突破 70s → E 记第 1 次慢失败（5s 间隔内首次，入账）
T+71s+    在途请求 B/C/D 相继超时 → 间隔内全部去重，不计数
T+75s+    后续请求依旧超时 → 跨过间隔，记第 2 次
          → 慢样本攒到确认次数（2~3），E 拉黑，blockUntil = now + TTL(30~60s)
TTL 内    选端时过滤屏蔽名单，E 被跳过
TTL 到期  E 惰性恢复，自动回到候选池
```

恢复机制我选了惰性恢复：不设定时器，选端时检查 `blockUntil`，过期即视为恢复。这个思路和 Envoy outlier detection 的 `base_ejection_time` 同构，但实现更轻——恢复完全被请求驱动，零后台开销。

```go
// 伪代码：选端过滤
candidates := filterHealthy(getUpstreamHosts())
candidates = rejectBlocked(candidates, nowMs())   // blockUntil 已过期的直接放回
if len(candidates) == 0 {
    // 不覆盖端点，交给 Envoy 默认选端 —— 下一篇的主题
}
setUpstreamOverrideHost(pick(candidates))
```

> TTL 恢复是个乐观假设：到期不等于健康。端点如果还在慢，打过去的请求重新开始攒慢样本，再花 2~3 次确认拉黑一轮——相当于用真实流量做探测，代价是每个 TTL 周期有一段糟糕的用户体验。要不要配主动健康检查（用最小模型探活提前解封），我还在权衡，至少当前流量规模下不值当。

## 实现要点：贴着 wasm 的约束走
------
骨架就是标准的 wasm-go 插件回调链：

```go
func init() {
    wrapper.SetCtx("endpoint-breaker",
        wrapper.ParseConfig(parseConfig),                     // fail-fast：非法配置直接 error
        wrapper.ProcessRequestHeaders(onReqHeaders),          // 读屏蔽名单 + 选端 override
        wrapper.ProcessResponseHeaders(onRespHeaders),        // 耗时统计的计时锚点
    )
}
```

几个关键实现决策，每条背后都是 wasm 执行模型的一条硬约束：

**回调里不做任何阻塞动作。** wasm 回调跑在 Envoy worker 线程上，同步做耗时操作会卡住该 worker 的所有请求；wasm 目标没有真线程，goroutine 不可用。好在断路器的判定全是内存操作——读名单、比对时间戳、CAS 写回，没有一处需要异步。

**屏蔽写回走 CAS 重试。** SDK 的 SharedData 语义决定了并发写必须循环重试：

```go
// 伪代码：SharedData CAS 写回（SDK 语义：冲突返回 ErrorStatusCasMismatch）
for i := 0; i < maxRetry; i++ {
    data, cas := proxywasm.GetSharedData(key)
    updated := mergeBlock(data, ep, blockUntil)
    if _, err := proxywasm.SetSharedData(key, updated, cas); err == nil {
        break
    }
    // cas mismatch → 别的 worker 先写了，重读重算再试
}
```

**fail-open 兜底。** wasm 框架对插件 panic 的兜底语义是 fail-open：wrapper 的 `recoverFunc` 捕获 panic 后，回调以零值 `ActionContinue` 返回，请求继续正常处理。这对断路器是理想行为——屏蔽逻辑自身崩溃，最坏结果是"不屏蔽"，绝不会挡流量。推论是故障完全静默，必须靠日志关键词告警兜住，调试期可以用 `WASM_DISABLE_PANIC_RECOVERY=true` 关掉兜底看原始栈。

**共存纪律。** `SetUpstreamOverrideHost` 一个请求只允许一个策略，断路器和其他 LB 类插件不能同挂；SharedData key 加插件前缀，防互踩。

> 参考实现可以直接看仓库里两个现成插件：ai-load-balancer 的 `global_least_request/lb_policy.go`（端点健康读取 + 指定 host 转发的完整姿势）、ai-proxy 的 `provider/failover.go`（SharedData 健康状态机 + 探测恢复）。我的屏蔽名单状态机基本是后者换了判定信号。

## 反思：这套设计粗糙但够用的边界在哪
------
坦率说，这是一个"单实例自洽、多副本将就"的设计，边界我列清楚：

- **阈值是刀切的。** 70s 对长上下文模型可能太严（正常推理就被拉黑），对轻量模型可能太松（慢节点拖 60s 依然在池里）。按 model 维度配差异化阈值是第一优先级的改进，配置结构上 `_rules_` 路由级覆盖直接可用。
- **SharedData 只覆盖单实例。** 多副本网关部署时，每个副本的屏蔽状态是割裂的，全局一致要走 Redis（key 加插件前缀、`{cluster}` hash tag 防 CROSSSLOT）。当前单副本部署下这不是问题，扩副本前必须补。
- **耗时统计的口径很粗。** 只看单次响应耗时，没有分位数、没有趋势。更精细的做法是滑动窗口内记录 P95，但那会引入事件序列存储——上一篇的设计里已经有窗口上限 20 条的先例，代价是 CAS 竞争显著加剧，我不确定值得。

------
下一篇写拉黑策略的补丁：**全拉黑放行**——候选集被屏蔽名单清空时，屏蔽逻辑主动退位，把控制权还给 Envoy 默认选端。宁可疑似的端点接到流量，也不主动拒绝请求，这个取舍值得单独一篇展开。

> 断路器做到最后，我体会到的核心不是"怎么拦"，而是"什么时候不拦"——屏蔽判定越激进，兜底路径就越重要。一个只在候选集非空时才起作用的断路器，看起来功能打折，实际上是所有流量的安全带。
