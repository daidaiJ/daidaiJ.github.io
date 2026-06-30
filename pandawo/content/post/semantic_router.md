---
title: "Semantic_router"
slug: "ai-gateway"
description: "vllm 语义路由解析"
date: 2026-06-30T13:04:01+08:00
lastmod: 2026-06-30T13:04:01+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["ai","llm","gateway"]
tags: ["golang"]
image: https://picsum.photos/seed/d97f5b27/800/600
---
# vLLM Semantic Router：不只是路由，是 AI 请求全生命周期治理

## 背景

最近在研究 vLLM 项目组推出的 Semantic Router 项目，结合源码分析和官方博客的几篇文章，整理下这个项目的核心设计和一些思考。

参考文章：
- [Micro-Agent: Frontier Models as Micro-Agent](https://vllm.ai/blog/2026-06-29-micro-agent-frontier-models)
- [v0.3 Themis Release](https://vllm.ai/blog/2026-06-05-v0.3-vllm-sr-themis-release)
- [Session-Aware Agentic Routing (SAAR)](https://vllm.ai/blog/2026-06-02-session-aware-agentic-routing)

## 一、项目定位

**vLLM Semantic Router (VSR)** 是一个信号驱动（Signal-Driven）的系统级智能路由器，面向 Mixture-of-Models (MoM) 架构。

它**不是**传统 API 网关，而是一个**请求理解 + 内容治理 + 智能分发**的中间层。

部署方式是 Envoy ext_proc sidecar：

```
Client ──► Envoy (port 8801)
                │
                │  gRPC ext_proc (127.0.0.1:50051)
                ▼
   ┌─────────────────────────────────┐
   │  vLLM Semantic Router (Go 进程)  │
   │                                 │
   │  ┌─ extproc gRPC server         │
   │  ├─ Signal Engine (18路并发)     │
   │  ├─ Decision Engine             │
   │  └─ Selection Engine            │
   │         │                       │
   │     CGO (Rust 动态库)            │
   │         ▼                       │
   │  ┌─ candle-binding (GPU)        │
   │  ├─ onnx-binding                │
   │  ├─ openvino-binding            │
   │  └─ ml-binding (KNN/KMeans/SVM) │
   └─────────────────────────────────┘
```

注意：所有 ML 推理通过 CGO 调用 Rust 动态库完成，项目中的 WASM 组件仅用于 Dashboard 前端的 DSL 编译器，不参与运行时推理。

## 二、Signal → Decision → Selection 三层流水线

### 信号提取层

系统并行提取 **18 种信号**，全部以 goroutine 并发执行：

| 分类 | 信号 | 说明 |
|------|------|------|
| 基础 | keyword, embedding, domain | 关键词/向量/领域 |
| 路由 | complexity, modality, language, context, structure | 复杂度/多模态/语言/上下文长度 |
| 安全 | jailbreak, PII, fact-check, authz | 越狱检测、隐私检测、事实核查、授权 |
| 对话 | conversation, reask, preference, user-feedback, kb, event | 上下文/重复提问/偏好/知识库 |

### 决策引擎

基于声明式 YAML 配置的 `Decision` 结构，支持布尔规则树（AND/OR/NOT 组合）：

```go
type Decision struct {
    Name      string
    Rules     RuleCombination  // 递归布尔表达式树
    ModelRefs []ModelRef       // 候选模型列表
    Algorithm *AlgorithmConfig // 选择算法配置
    Plugins   []DecisionPlugin // 安全/缓存/RAG 等插件
    Emits     []EmitDirective  // 声明式副作用指令
}
```

### 模型选择层

实现 **10+ 种选择算法**：

| 算法 | 来源 | 机制 |
|------|------|------|
| Elo | RouteLLM | Bradley-Terry 加权评分 |
| RouterDC | arXiv:2409.19886 | 双重对比学习 query-to-model |
| AutoMix | arXiv:2310.12963 | POMDP 级联 + 自验证 |
| KNN/KMeans/SVM/MLP | FusionFactory | 传统 ML + 神经网络 |
| RLDriven | Router-R1 | 强化学习（Thompson Sampling） |
| MultiFactor | — | 质量 + 时延 + 成本 + 负载加权 |
| SessionAware | — | 会话级路由一致性 |

## 三、ext_proc 智能路由工程实现

路由决策在 RequestBody 阶段完成，信号采集跨越整个请求生命周期，response 阶段反哺下一次决策：

```
Request → Headers → Body → [上游推理] → Resp Headers → Resp Body → Client
             │           │                              │              │
         安全门控    信号+决策+选模型                  记录 TTFT     TPOT/成本/缓存
```

### 负载感知

全局状态 `map[model] → {map[token] → entry{start_time}}`，`Begin(model) → token` / `End(model, token)`。超过 10min 的 entry 自动淘汰（自愈机制，防 panic/断连导致计数泄漏）。

### 时延感知

EMA 平滑（α=0.3）+ 滑动窗口（max=1000）+ 百分位查询（默认 p95），采集两个核心指标：

- **TPOT**（Time Per Output Token）：ResponseBody 阶段 `completionLatency / completionTokens`
- **TTFT**（Time To First Token）：streaming 首个 chunk

### 成本感知

静态配置价格 + 运行时计量：

```yaml
models:
  - name: gpt-4o
    pricing:
      prompt_per_1m: 2.50
      completion_per_1m: 10.00
```

运行时：`cost = prompt_tokens * prompt_rate + completion_tokens * completion_rate`

### MultiFactor 评分

```
候选模型列表
    │
    ▼
1. SLO 硬过滤（MaxTPOTMs / MaxTTFTMs / MaxCostPer1M / MaxInflight）
    │
    ▼
2. 信号采集（quality 静态配置 / latency p95 / cost 配置 / load 并发数）
    │
    ▼
3. Min-Max 归一化到 [0,1]
    │
    ▼
4. score = wQ*quality + wL*latency + wC*cost + wLoad*load
   权重自动归一化 sum=1，默认等权 0.25
```

## 四、路由的真正含义

"选模型"只是 RequestBody 阶段的一个子步骤。整个系统在请求全生命周期做远不止路由的事：

### 请求进入时：安全门控

| 能力 | 行为 |
|------|------|
| Jailbreak 检测 | 越狱攻击 → 直接返回 403 |
| PII 检测 | 隐私信息 → 按策略拒绝/脱敏 |
| 速率限制 | 超限 → 返回 429 |

### 转发前：请求改写

| 能力 | 说明 |
|------|------|
| RAG 注入 | 从向量库检索相关文档，注入 messages |
| Memory 注入 | 注入用户历史对话记忆 |
| Prompt 压缩 | 评估文本过长时压缩，减少 token |
| System Prompt 注入 | 按 decision 分支注入不同 system prompt |
| 工具选择 | 按 decision 配置选择暴露哪些 tools |

### 响应返回时：后处理

| 能力 | 说明 |
|------|------|
| 语义缓存 | embedding 相似度匹配 → 直接返回缓存 |
| 幻觉检测 | NLI 模型检测 → 注入警告或拦截 |
| 格式转换 | OpenAI ↔ Anthropic 协议互转 |
| 记忆存储 | 将对话存入记忆系统供未来使用 |

**"Semantic" 在哪？** 不在"路由到哪个 cluster"这一步，而在"决定怎么处理这个请求"这一步。它理解请求的语义，然后决定：**要不要发**（安全门控）、**发给谁**（模型选择）、**怎么发**（请求改写）、**发完怎么处理**（响应后处理）。

## 五、路由决策 → Envoy 分发链路

路由器**不直接选 Pod**。它选模型，通过 header mutation 告诉 Envoy 去哪个 cluster，Pod 选择由 Envoy 的 LB 完成：

```
第一步：决策引擎选模型
    Signal → Decision → Selection → selectedModel = "deepseek-r1"

第二步：模型 → Backend 解析
    PreferredEndpoints = ["ep-vllm-rack2"]
    ExternalModelIDs["vllm"] → "deepseek-ai/DeepSeek-R1"

第三步：构建 Header Mutation
    x-selected-model: "deepseek-r1"      ← Envoy 路由匹配 key
    Authorization: "Bearer sk-xxx"       ← 下游凭证

第四步：Body Mutation
    {"model": "auto"} → {"model": "deepseek-ai/DeepSeek-R1"}

第五步：Envoy 根据 header 选择 cluster + Pod
    x-selected-model prefix "claude-"   → anthropic_api_cluster
    x-selected-model regex /^(gpt-|o1-)/ → openai_api_cluster
    else                                → vllm_backend_cluster
    （Pod 级负载均衡由 Envoy ROUND_ROBIN 完成）
```

## 六、四大核心机制

### 6.1 语义缓存

不是精确匹配 query 文本，而是 **embedding 向量相似度匹配**：

```
请求 "如何用 Python 排序"
    │
    ▼
1. 提取 query
2. 检查跳过：含 RAG/Memory 的决策跳过缓存（防泄露用户数据）
3. 生成 embedding
4. HNSW 向量搜索 (M=16, efConstruction=200, efSearch=50)
5. similarity >= threshold ?
   YES → 命中！返回缓存
   NO  → 请求发往模型，响应返回后写入缓存
```

缓存后端：内存 + HNSW 索引 / Milvus / Redis，支持按 decision 独立配置 `similarity_threshold` 和 TTL。

### 6.2 幻觉检测

两层检测，通过 CGO 调用 Rust Candle binding 的 NLI 模型：

- **基础版**：`DetectHallucination(context, question, answer)` → `{detected, confidence, unsupported_spans}`
- **NLI 增强版**：`DetectHallucinationWithNLI(...)` → span 级标注 `{text, start, end, nli_label, severity, explanation}`

检测后按 action 处理：`header` 设置警告 header / `body` 在响应前插入警告 / `none` 仅记录 metrics。

### 6.3 循环检测

**Reask 检测**：计算当前 turn 与历史 turns 的 embedding cosine 相似度，倒序检查连续超过阈值的 streak：

```
规则: { threshold: 0.85, lookback_turns: 3 }
streak >= lookback ? 触发 : 不触发
```

**Conversation 检测**：检测工具调用循环（lastMessage == tool_result / assistantToolCallCount > toolResultCount）。

### 6.4 记忆存储与召回

三种记忆类型：

| Type | 含义 | 例子 |
|------|------|------|
| semantic | 事实/偏好/知识 | "用户的夏威夷预算是 $10K" |
| procedural | 操作步骤/指令 | "部署 payment-service: npm build → docker push" |
| episodic | 会话摘要/事件 | "2024-12-29 用户规划了夏威夷旅行" |

生命周期：
- **存储**：Response 阶段异步 goroutine，提取 userMessage + assistantResponse + history → `MemoryExtractor.ProcessResponseWithHistory(...)`
- **检索**：Request 阶段，自适应阈值（找最大 score 断层，只返回强相关记忆），hybridSearch
- **注入**：格式 `"以下是用户之前对话的相关上下文：\n- {memory.content}"`，位置在 system message 之后、第一条 user message 之前

安全设计：检索按 UserID 隔离，含 RAG/Memory 的 decision 跳过语义缓存，jailbreak 拦截的响应不存入记忆。

## 七、v0.3 Themis Release 要点

2026 年 6 月 5 日发布的 v0.3 是一个里程碑版本，350+ commits，核心变化：

- **配置稳定**：YAML 配置契约固化，生产可用
- **协议兼容**：新增 Anthropic 协议支持，OpenAI ↔ Anthropic 格式互转
- **推理后端扩展**：Intel OpenVINO 支持（x86 也能跑推理）
- **性能验证**：RouterArena 排名 #1（75.4 分）
- **生态接入**：Kubernetes Operator、Helm Chart、Grafana Dashboard

## 八、SAAR：会话感知的 Agentic 路由

Session-Aware Agentic Routing 解决的核心问题：在 Agent 场景下，路由切换模型会导致会话状态丢失。

SAAR 的设计：

- **会话记忆由路由器管理**，不是推理引擎
- **硬锁定（Hard Lock）**：Agent 工作流期间锁定当前模型，不切换
- **重置边界（Reset Boundaries）**：明确哪些操作可以重置会话状态
- **切换经济学（Switch Economics）**：量化切换成本（上下文重建、延迟、缓存失效），只有收益 > 成本才切换
- **Replay Traces**：切换模型时，将之前的对话历史 replay 给新模型

## 九、Micro-Agent：多模型协作

Micro-Agent 的核心理念：前沿模型不再单独工作，而是在 API 服务层实现多模型协作。

六大协作机制：

| 机制 | 说明 |
|------|------|
| Confidence | 模型输出置信度评分 |
| Ratings | 多模型对同一输出打分 |
| ReMoM | Mixture-of-Models 的路由+混合 |
| Fusion | 多模型输出融合 |
| Workflows | 预定义的多模型工作流 |
| Auto Recipes | 自动发现最优模型组合 |

## 十、AI 网关演进方向

### 推理引擎正在变成"无状态执行单元"

```
传统 API 网关:
  Client ──► [鉴权/限流] ──► Backend ──► Response

AI 网关（新范式）:
  Client ──► [理解层] ──► [增强层] ──► [治理层] ──► Inference ──► [审计层] ──► Response
                │              │            │                         │
            信号提取        RAG/记忆注入   选模型/改参数             幻觉检测
            意图分类        prompt压缩     限流/缓存                 格式转换
            安全检测        工具选择       凭证注入                  成本计量
```

| 维度 | 以前（推理引擎为中心） | 未来（网关为中心） |
|------|----------------------|-------------------|
| Prompt 管理 | 应用层拼 prompt | 网关层动态组装 |
| 上下文 | 应用层管理对话历史 | 网关层记忆系统自动注入 |
| 安全 | 模型内置 / 外挂审核服务 | 网关层内联（零延迟） |
| 模型选择 | 应用层硬编码 | 网关层信号驱动自动决策 |
| 缓存 | 应用层 Redis | 网关层语义缓存 |

### 稳定前缀 vs 动态注入

当前设计的结构性问题：每次请求的注入内容独立检索，模型看到的"世界"每轮都在变。

建议的分层架构：

```
┌───────────────────────────────┐
│  Session Layer（稳定）          │  创建时确定，session 内不变
│  system prompt                 │
│  user profile snapshot         │
│  turn history (append-only)    │
├───────────────────────────────┤
│  Request Layer（动态）          │  每轮独立
│  real-time RAG                 │
│  safety detection              │
│  model selection               │
├───────────────────────────────┤
│  Response Layer（后处理）       │  响应后执行
│  hallucination check           │
│  memory extraction             │
│  session history append        │
└───────────────────────────────┘
```

这与 OpenAI Responses API 的 `previous_response_id` 设计方向一致 — 服务端维护完整上下文链，上下文是追加式的，不是每次重建的。

### 待解决问题

1. **个性化 vs 缓存矛盾**：含 RAG/Memory 的请求跳过缓存，最有价值的请求享受不到缓存收益
2. **延迟叠加**：信号 ~10ms + RAG ~50ms + 记忆 ~30ms + 幻觉 ~100ms ≈ 190ms 额外延迟
3. **网关可用性瓶颈**：解法是 `failure_mode_allow: true`，网关故障时直通后端

## 总结

vLLM Semantic Router 的核心价值不在"路由"而在"治理"。它把传统 API 网关的鉴权/限流能力，扩展到了 AI 语义理解的维度：理解请求意图、安全门控、智能选模型、请求改写、响应后处理、记忆管理。

从 v0.3 Themis 到 SAAR 到 Micro-Agent，这个项目在快速演进。方向很明确：推理引擎变成无状态执行单元，智能向网关层迁移。但动态注入 vs 上下文一致性、个性化 vs 缓存的矛盾，仍然是需要解决的核心问题。
