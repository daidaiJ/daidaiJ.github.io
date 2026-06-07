---
title: "AI 编程助手的上下文压缩：only-cc-lite 设计与 98 个真实会话的压测分析"
slug: "only-cc-lite-context-compression"
description: "从 Headroom 提取的零 ML 依赖上下文压缩库，通过增量压缩和前缀缓存保护，在真实编程助手会话中验证压缩收益"
date: 2026-06-07T13:12:44+08:00
lastmod: 2026-06-07T13:12:44+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
tags: ["ai",  "context-enginer"]
categories: ["技术"]
---

## 为什么需要上下文压缩

AI 编程助手（Claude Code、Qwen Code、Cursor 等）的工作模式是**累积式**的：每次用户发一条消息，客户端会把从会话开始到当前的所有消息一起发送给 LLM API。

这意味着一个 30 轮的会话，第 30 次请求包含了前 29 轮的全部历史。如果中间执行了 `cargo build`、`npm run build`、grep 搜索等工具调用，大量构建日志、搜索结果会被反复发送。

> 实际使用中，一个中等复杂度的调试会话，单次请求的 input tokens 轻松突破 10 万。累积下来，一个会话消耗几百万 tokens 很常见。

问题的核心：**大部分历史内容是重复的，但不能直接丢弃**。LLM 需要上下文来理解代码变更的背景，而 LLM 提供商的前缀缓存（prompt cache）机制要求历史消息的字节序列保持不变。

only-cc-lite 就是为解决这个问题而生的。

## 设计原则

从 [Headroom](https://github.com/chopratejas/headroom) 提取，但做了关键简化：

| 特性 | headroom-core | only-cc-lite |
|------|--------------|-------------|
| 内容类型检测 | Magika ONNX + 正则 | 纯正则 |
| Token 计数 | tiktoken-rs + HuggingFace | 字符密度估算 |
| 语义相关性评分 | fastembed ONNX | BM25 纯关键词 |
| 二进制膨胀 | ~50-80MB (ONNX) | <5MB |
| 传递依赖 | 4182 | ~80 |

三个核心设计原则：

1. **零 ML 依赖** — 不引入 ONNX Runtime、fastembed、HuggingFace tokenizers，纯 Rust 实现
2. **增量压缩** — 只压缩 user 侧的增量内容，assistant 消息原样保留
3. **前缀缓存安全** — 压缩后的请求，历史部分的字节序列与原始请求完全一致

## 增量压缩模型

传统做法是压缩整个请求体。但这会破坏 LLM 提供商的前缀缓存——提供商通过 SHA-256 哈希请求的前 N 个字节来判断是否命中缓存，任何字节变化都会导致缓存失效。

only-cc-lite 的做法是**只压缩最新 user 消息中的可压缩内容块**：

```text
请求消息结构：
┌─────────────────────────────────────┐
│ user msg #0  (frozen)               │  ← 不动
│ assistant msg #0  (frozen)          │  ← 不动
│ user msg #1  (frozen)               │  ← 不动
│ assistant msg #1  (frozen)          │  ← 不动
│ ...                                 │
│ user msg #N  ← LIVE ZONE           │  ← 只压缩这里
│   ├─ text block "请帮我修复..."     │  ← 不压缩（短文本）
│   ├─ tool_result: 构建日志 8000 tok │  ← 压缩！(log_compressor)
│   ├─ tool_result: grep 结果 2000 tok│  ← 压缩！(search_compressor)
│   └─ tool_result: git diff 1500 tok │  ← 压缩！(diff_compressor)
│ assistant msg #N  (cache hot zone)  │  ← 不动
└─────────────────────────────────────┘
```

对应的 Rust 实现入口：

```rust
use only_cc_lite::{compress_request, Provider};

let outcome = compress_request(
    &body,
    Provider::Anthropic,
    "claude-sonnet-4-5-20250929",
    None, // ccr_store，可选
)?;

match &outcome.body {
    Some(compressed) => {
        // 转发压缩后的 body 到上游 API
        forward_to_upstream(compressed);
    }
    None => {
        // 无可压缩内容，转发原始 body
        forward_to_upstream(&body);
    }
}
```

> 这个模型的核心洞察：编程助手会话中，assistant 消息（代码、解释）占比大但不适合压缩（格式敏感），而 user 消息中的工具结果（日志、搜索结果）是最理想的压缩目标——结构化、冗余高、可安全截断。

## 四种压缩策略

压缩器通过正则检测内容类型，自动选择最合适的策略：

### LogCompressor — 构建/运行日志

识别 `ERROR`、`WARN`、`Traceback`、`panic`、`failed` 等模式，提取关键错误信息，丢弃重复的编译输出。

```
输入 (8000 tokens):
  Compiling foo v0.1.0
  warning: unused variable `x` --> src/main.rs:42:9
  error[E0308]: mismatched types --> src/lib.rs:100:5
  ... (几百行编译输出)

输出 (1200 tokens):
  [ERROR] src/lib.rs:100:5 - mismatched types
  [WARN] src/main.rs:42:9 - unused variable `x`
  ... (只保留错误和警告)
```

### SearchCompressor — 代码搜索结果

匹配 `file:line:content` 格式的搜索结果，保留匹配行，丢弃上下文。

### DiffCompressor — Git Diff

解析 unified diff 格式，保留变更摘要（文件名、变更类型），压缩具体 diff 内容。

### SmartCrusher — JSON 数组

解析 JSON 数组，保留首尾元素，中间用统计摘要替代。

```json
// 输入: 100 个元素的数组
[{"id":1,"name":"a"},{"id":2,"name":"b"},...,{"id":100,"name":"zz"}]

// 输出: 首尾 + 摘要
[{"id":1,"name":"a"}, "... 98 more items ...",{"id":100,"name":"zz"}]
```

> SmartCrusher 的压缩效果最好，单轮可达 60-90%。但在真实编程助手中，触发频率最低——大部分工具调用返回的是日志和搜索结果，不是纯 JSON 数组。

## 前缀缓存保护机制

这是 only-cc-lite 最关键的设计。三层保护确保压缩不会破坏 LLM 提供商的前缀缓存：

### 第一层：Frozen Zone

历史消息（所有 assistant 消息 + 之前的 user 消息）完全不动。通过 `frozen_message_count` 参数确定冻结边界。

### 第二层：Live Zone 限制

只在最新 user 消息内寻找可压缩的 content blocks。Assistant 消息即使包含大段内容也不压缩。

### 第三层：Byte-range Surgery

这是最精妙的部分。`apply_replacements()` 函数做字节级精确替换：

```text
out = body[..block_start] || replacement || body[block_end..]
```

被替换的 block 通过 `serde_json::value::RawValue` 的借用切片定位其在原始 buffer 中的偏移量。替换前后，block 外部的字节**逐字节复制**，不做任何重新序列化。

这意味着：

```text
原始请求:  [prefix bytes...] [block A] [suffix bytes...]
压缩后:    [prefix bytes...] [block A'] [suffix bytes...]
                                   ↑
                          只有这里变了
```

前缀的 SHA-256 在压缩前后完全一致，LLM 提供商的 prompt cache 命中率不受影响。

> 实际上，这也是为什么压缩器只压缩最后一条 user 消息——更早的消息即使是 user 消息，修改它们也会破坏前缀缓存。

## 真实会话压测

为了验证压缩效果，基于真实的 AI 编程助手会话日志做了评估。

### 测试数据

| 维度 | 数值 |
|------|------|
| 压测会话数 | **98 个**（Claude Code 2 个 + Qwen Code 96 个） |
| 对话轮次 | 4,210 |
| 总 input tokens | 3.28 亿 |
| 涉及模型 | mimo-v2.5-pro、minimax-m2.7、kimi-k2.6、glm-5、glm-4.7-flash、deepseek-v4-flash、qwen3.6-plus 等 |

会话来源通过环境变量自动定位（`$USERPROFILE` 或 `$HOME`），不依赖任何硬编码路径。会话文件格式包括 Anthropic Messages API（Claude Code）和 OpenAI Chat Completions（Qwen Code）两种。

### 总体指标

| 指标 | 数值 |
|------|------|
| User 内容（可压缩） | 10.3 MB |
| Assistant 内容（保留不动） | 3.3 MB |
| Tokens 节省 | 103,256 |
| Bytes 节省 | 452,770 |
| **整体 User 压缩率** | **4.4%** |

4.4% 看起来不高？这恰恰反映了编程助手的真实使用特征。

### 场景收益分析

**收益明显的场景**——user 消息中包含大块结构化内容：

| 场景 | 策略 | 单轮压缩率 | 触发条件 |
|------|------|-----------|---------|
| 构建失败日志 | log_compressor | 50-100% | `cargo build`、`npm run build` 输出大量错误 |
| 运行时错误堆栈 | log_compressor | 70-100% | Python traceback、Node.js rejection |
| 代码搜索结果 | search_compressor | 50-80% | grep/ripgrep 返回大量匹配 |
| Git diff | diff_compressor | 40-60% | 多文件变更的 diff 输出 |
| JSON 数据 | smart_crusher | 60-90% | API 响应、配置文件 |

典型案例：一个 28 轮会话中，第 1 轮就压缩了 14,790 tokens（构建日志），单轮压缩率 100%。

**几乎无收益的场景**——占绝大多数轮次：

| 场景 | 占比 | 原因 |
|------|------|------|
| 短指令对话 | ~60% 轮次 | "fix this bug"、"add a test" < 500 bytes |
| 纯文本粘贴 | ~15% 轮次 | 错误描述、需求说明等非结构化文本 |
| 小文件内容 | ~10% 轮次 | 单个函数/配置片段 < 5KB |
| 对话式交互 | ~10% 轮次 | 追问、确认、解释 |

98 个会话中 73 个（74%）未产生任何压缩——整个会话没有出现大块结构化内容。

```
会话压缩收益分布（98 个会话）：

无压缩 ████████████████████████████████████████  73 个 (74%)
< 1%   █████                                     7 个 (7%)
1-5%   ████████                                  12 个 (12%)
5-15%  ██████                                    6 个 (6%)
```

收益高度集中：**Top 5 会话贡献了 52% 的总 tokens 节省**。

### 策略命中统计

| 策略 | 命中轮次 | 贡献占比 |
|------|---------|---------|
| log_compressor | 57 turns | ~85% |
| diff_compressor | 8 turns | ~8% |
| search_compressor | 2 turns | ~5% |
| smart_crusher | 1 turn | ~2% |

`log_compressor` 是绝对主力。这也符合直觉——编程助手中最常见的"重内容"就是构建和运行日志。

### 与会话长度的关系

| 会话轮次 | 压缩情况 |
|---------|---------|
| 短会话 (< 10 轮) | 通常无压缩，除非首轮就有大日志 |
| 中等会话 (10-50 轮) | 部分有压缩，取决于是否触发构建/搜索 |
| 长会话 (50+ 轮) | 更可能遇到构建失败，但平均压缩率不一定更高 |

> 结论：压缩收益与会话长度无关，与是否触发"重内容"工具调用强相关。一个 338 轮的长会话可能压缩率很低（如果都是短指令），而一个 5 轮的调试会话可能单轮压缩 90%。

## 运行自己的压测

```bash
# 克隆仓库
git clone https://github.com/daidaiJ/only-cc-lite.git
cd only-cc-lite

# 运行评估（自动发现本地会话文件）
cargo bench --bench eval_runner

# 查看报告
cat target/eval-report.txt   # 人类可读
cat target/eval-report.json  # 程序消费
```

支持的 Agent CLI：

| Agent CLI | 会话目录 | 日志格式 |
|-----------|---------|---------|
| Claude Code | `~/.claude/projects/*/*.jsonl` | Anthropic Messages API |
| Qwen Code | `~/.qwen/projects/*/chats/*.jsonl` | OpenAI Chat Completions |

## 总结

only-cc-lite 的核心价值不在于压缩率有多高，而在于**压缩的安全性**：

1. **零侵入** — 只压缩最后一条 user 消息，不动历史，不破坏前缀缓存
2. **零依赖** — 纯 Rust，无 ONNX/tokenizer，<5MB 二进制
3. **零风险** — 压缩失败自动降级为 passthrough，不影响正常请求

在真实编程助手场景下，整体压缩率 4.4%，但"重内容"场景下单轮可达 50-100%。对于重度使用构建/调试/搜索的开发者，长期累积的 tokens 节省可观。对于以对话为主的轻量使用，压缩收益有限但也不会引入额外开销。

> 本质上这是一个"有则赚，无则不亏"的设计——压缩器只在有明确收益时才出手，其他时候完全透明。

---

**项目地址**: [github.com/daidaiJ/only-cc-lite](https://github.com/daidaiJ/only-cc-lite)

**许可证**: Apache-2.0
