---
title: "上下文减法（二）：输出侧的四种省法"
slug: ctx-lean-2-output
description: ""
date: 2026-09-12T08:52:47+08:00
lastmod: 2026-09-12T08:52:47+08:00
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
    - agent
    - skill
    - token优化
image: https://picsum.photos/seed/48034fdc/800/600
---
# 上下文减法（二）：输出侧的四种省法
------
> 上一篇压缩的是"模型读进来的"，这篇是反方向：模型吐出去的。输出侧手段的原理都是改模型的行为方式，不用动基础设施，装个 skill 或 output style 就生效——门槛低，最近在 trending 上扎堆（ponytail、i-have-adhd 都在周榜上）。我把手头四种按目标分开记，它们的差别比相似处重要。

先交代一个共同背景：这类 skill 的数字全部是项目自报，没有独立基准。它们能冲上 trending 靠的是 README 表格和社交媒体传播，传播链上没有验算环节——上一篇里 rtk 被 JetBrains 复测出反向数据的先例在这边同样适用。下文所有百分比按方向性参考理解，真基准是自己跑一天日常任务看前后账单。

## caveman：语言层压缩，省 ~75%
caveman 的规则很机械：去掉冠词、客套话、hedging（just/really/basically 全砍），允许片段句，用箭头表达因果（X -> Y），技术术语和代码块不动。官方口径省 ~75%，英文场景体感相仿：

> Not: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
> Yes: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"

它省的是 filler 不是信息，判断标准就是去掉冠词和客套后技术内容是否原样。代码解释、错误分析这类结构化输出几乎无损；但中文场景收益打折扣——中文没有冠词，客套话占比也低。

另一个使用注意：它的 skill 描述里写明了触发后每轮都保持激活、不会自动漂移回正常文风，关掉要显式说 stop。这种"状态粘性"是这类 skill 的标配设计，不然省三个字漂两个填充词就白装了。

## stop-slop：不省量，去 AI 腔
我固化成 skill 的 stop-slop 目标和 caveman 完全不同：不追求短，追求把可预测的 AI 写作模式清掉——填充短语、二元对比结构、被动语态、"听起来像金句就重写"。

这两个经常被混为一谈，实际方向相反：caveman 为了短可以牺牲节奏，stop-slop 为了自然可以多花字，同时开会打架。我的分工：写文章用 stop-slop，终端快速问答用 caveman。

## ponytail：行为层，省的是 diff 面积
trending 上的 ponytail（"the laziest senior dev"）不碰语言碰行为：让 agent 按最懒的资深工程师方式干活——最小改动、不过度工程、能不加文件就不加。

它省 token 的路径是间接的：diff 小了，review 的上下文小了，连带返工和讨论的轮次少了。严格说省的不是单条回复，是整个任务的上下文足迹。四手段里我最看好这类：行为约束的收益不止省钱，还直接降低 agent 把简单事做复杂的概率。

## i-have-adhd：output style，收敛话痨
i-have-adhd 是个 output style，解决 agent 话痨：三句能说完的事铺垫十句。和 caveman 的区别是不砍到片段化，只收敛结构——结论先行、不复述问题、不重复已说过的内容。

适合当日常默认档，caveman 那种激进档留给明确要省的场景。

## 共同的天花板
输出侧所有手段共有一个局限：只影响生成，不影响阅读。省的是钱和注意力，不会让上下文窗口多装一条有用的工具输出——窗口管理还是靠上一篇的管道侧手段。两篇是互补关系：管道侧决定模型能看到什么，输出侧决定模型说多少，两头都要做，但别指望一头替代另一头。
