---
title: "OpenSandbox Pool 压测自噬复盘：销毁 293，运行 193"
slug: opensandbox-pool-churn
description: ""
date: 2026-09-12T08:52:46+08:00
lastmod: 2026-09-12T08:52:46+08:00
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
    - kubernetes
    - OpenSandbox
    - 压测排障
image: https://picsum.photos/seed/a1d6f19c/800/600
---
# OpenSandbox Pool 压测自噬复盘：销毁 293，运行 193
------
> 9 月 10 日在 13 节点集群上给 OpenSandbox 的池化模式做压测，撞上一组反直觉的数字：全程销毁了 293 个池 pod，Running 峰值只有 193——池子在一边等 pod 一边删 pod。当天闭环：根因定位、对照上游 #1423、A/B 验证修复（PR #1425）。这篇按证据链复盘，重点是一张快照的反推和几个推翻直觉的结论。

## 现象四件套
环境：poolMin=20 / poolMax=400，池模板 2c4G，13 个候选节点，负载按 40 一档递增到 ~100 并发。四个反直觉的现象同时出现：

1. **销毁量畸高**：293 SuccessfulDelete 对 193 Running 峰值，删除远多于沙箱主动释放
2. **自噬标志**：`supplyCnt>0`（有 sandbox 在等 pod）与 `scaleIn>0`（池在删 pod）并存
3. **池冻结**：churn 期间 Pool 零 reconcile，重启 controller 无效
4. **水位反直觉**：alloc 不到 poolMax 的 1/3（~100/400）就触发——"打满才出事"的直觉不成立

## 一张快照的反推
~100 并发时对控制器日志采样：`maxNewPods=272`、`desiredSchedulableCnt=121`、`totalPodCnt=128`。三个数字互相咬合：

`totalPodCnt = PoolMax - maxNewPods = 400 - 272 = 128`（terminating pod 不可见）。而 `desired = alloc + supply + desiredBuffer = 121`：如果 buffer 在带内 [10, 40]，代入公式得 desired 必然 ≥ 128，不可能等于 121。**唯一自洽解是 buffer 越过了上限 40**——alloc≈80、supply≈19、buffer≈48。

也就是说：128 个 pod 只有 ~80 个被分配，~48 个躺在 idle，19 个 sandbox 在等 pod，池子同时在删 pod。pod 就绪只要 6-10 秒，分配在下一个 reconcile 周期就该发生——48 个长期卡在 idle 是真 Pending，池子却把它们当成"富余缓冲"在删。

## 根因：三个缺陷叠加成循环
位置都在 `pool_controller.go`（修复前的 fork 版本）：

1. **buffer 统计口径包含未 Ready 的 pod**。`bufferCnt = schedulableCnt - allocatedCnt`，Pending/ContainerCreating 全算富余；而分配器只把 Ready pod 分给 sandbox。调度卡住的 pod 长期躺在 idle 集合，在扩缩容公式里被计成缓冲
2. **scale-in 无门控，且最老优先**。`pickPodsToDelete` 只按 `CreationTimestamp` 升序——最老的 idle pod 恰是卡得最久、马上就绪的那批，trim 定向淘汰最接近可用的 pod。utils 里考虑 Ready 状态的 `ComparePodsForDeletion` 存在，但只用在滚动更新路径
3. **门控不对称 + 删除正反馈**。创建侧有 25% `maxUnavailable` 预算门，删除侧没有任何上限；每删一个未 Ready pod，`notReadyCnt-1`，创建预算+1——删除动作直接放大下一轮创建

循环全貌：创建 → 调度不上（Pending）→ 计入 buffer → buffer 越上限触发 trim → 最老优先删掉 → 预算回血 → 再创建。**20-30 个长期 Pending 不是副作用，是 25% 预算的平衡点**：desired≈120 时预算≈30，控制器创建到顶线即停，与观测精确吻合。

## 触发条件是一条不等式
把代码翻成数学：buffer 在带内时 `scaleIn ≡ 0`（代数恒等，无论 alloc 多大都剪不动）；trim 只能发生在 buffer 越上限的带外，触发条件联立为：

```
alloc ≳ 3×bufferMax − supply   且   alloc ≳ 2×supply + 3×midpoint
```

三个推论，逐条回收排查当时的疑问：

1. **为什么 MVP 小池（poolMin 4 / poolMax 24）复现不出来**：带外锚点 midpoint 是绝对值（25），不随池规模缩小，小池的 alloc 在数学上不可能越过不等式——复现失败不是操作问题
2. **为什么 1/3 水位就中**：门槛是绝对数不是占比，alloc≈100 时 `100 > 2×10+75` 已满足，"水位线"直觉失效
3. **创建超时参数不在风暴环路上**：风暴的燃料是"未 Ready 在途被误计入 buffer"，循环自给自足，不需要任何请求先失败。测试环境 60s 失败潮只是加速器——生产 240s 没有失败潮照样中招

## A/B 验证，和一次差点污染结论的部署失误
k3s 双节点缩比复现：主容器 `sleep 70 && touch /tmp/ready` 模拟慢启动（对应上游 kata-qemu 60s+），同负载（400 创建请求）、同池规格，唯一变量是 controller 代码。

前侧（pre-#1425）四症状全部复现：TOTAL 锯齿 143→124→145→132→…、冻结 ≥14 分钟、alloc 99 + 25 Pending 冻结终态。

后侧第一次跑出来"仅 1 次删除、无冻结"，差点直接写进报告判定修复有效。复盘取证发现**那次 #1425 根本没接管**：镜像没进 worker 节点的 containerd，新 pod 一直没 Ready，`kubectl logs deploy/` 静默打到旧 pod。关键指纹是决策日志的 caller 行号——前侧二进制的决策日志在 `pool_controller.go:1119`，#1425 因为新增了 `countReadyIdlePods` 漂移到 `:1132`，两轮日志全是 `:1119`。

重测（先验接管：RS `readyReplicas=1` + caller `:1132` 实测）：

| 指标 | 前（A） | 后重测（B′） |
|---|---|---|
| 决策连续性 | 冻结 ≥14 分钟 | 全程连续，869 次决策，最大空窗 ≤1 分钟 |
| TOTAL 轨迹 | 锯齿自噬，冻死在 124 | 每波一次性收缩 137→108，精确收敛到 alloc+bufferMin |
| 删除 | 无上限 | 每轮 ≤25% 封顶 |
| buffer 口径 | 含 Pending/在途 | Ready-only，bufferCnt=0 实时可见 |

判定：前坏后好成立，本 fork 合 #1425（上游 [#1423](https://github.com/opensandbox-group/OpenSandbox/issues/1423) / [#1425](https://github.com/opensandbox-group/OpenSandbox/pull/1425)）。

> 方法论教训进了复现配方：A/B 切镜像后必须先验证新 pod 接管再开压。`kubectl rollout status` 卡住时不会把错误推到操作者眼前，`kubectl logs` 会静默打旧 pod——"看起来在跑"和"新代码在跑"是两件事。

## 残留
#1425 的 scale-in 仍会删除在途超额 pod（未 Ready 先删，而非跳过）。因有封顶 + 单轮收敛，不复发，属可控行为，另开小 issue 跟进，不重开 #1423。

## 小结
自噬机制一句话：**不可观测的失败被计成富余，富余触发收缩，收缩回血扩容预算。**任何"把在途当库存"的池化系统都有同款风险。修法三板斧也通用：口径改成 Ready-only（假库存消失）、删除加 maxUnavailable 封顶（单轮收敛）、错误路径软 requeue（池不脱离管控）。
