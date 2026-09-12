---
title: "上下文减法（一）：压缩工具输出的三条路线"
slug: ctx-lean-1-pipeline
description: "上下文减法第一篇：按拦截位置把压缩工具输出的方案分成三条路线（命令执行点、API 传输层、工具封装层），重点比较各自的失效方式。"
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
    - ai
tags:
    - mcp
    - agent
    - token优化
image: https://picsum.photos/seed/7b2e4f9a/800/600
---
# 上下文减法（一）：压缩工具输出的三条路线
------
> agent 干活的成本大头是工具输出：一次构建日志、一份搜索结果、一次 grep，动辄几千 token 进上下文。这半年陆续用了三个从"输出进上下文之前"下手的工具：rtk（命令执行点）、headroom（API 传输层）、context-mode（工具封装层），自己也从 headroom fork 过一个压缩库（only-cc-lite）。这篇按拦截位置整理三条路线的差异，重点是各自的失效方式——压缩率是宣传数字，怎么失效才决定敢不敢用。

## 路线一：rtk，在命令执行点包一层
rtk 是 Rust 写的 CLI 代理，通过 hook 把 agent 的命令调用包一层，输出进上下文前先压缩，go build / go test / golangci-lint 这类高噪声输出正好是它压缩率最高的场景（60-90%）。

优点是最早见效：不改架构，装个 hook 全量生效。

但我实际用下来踩到一个比费 token 更麻烦的坑：rtk 把 `go build` 改写成自己的包装调用后，输出误导性的 "Go build: Success"——而真实退出码可能仍是非零（卡巴斯基实时扫描锁 go 链接产物导致的偶发失败，就被这个 Success 盖住了）。agent 拿到 Success 就走下一步，错误被静默吞掉，只能靠"看产物文件在不在"兜底。

> 这类工具的通用风险：在压缩输出的时候顺手改变了输出语义。对 agent 来说，退出码和报错文本是它判断世界的全部依据，格式压缩可以，语义说谎不行。

社区这边的数据更难看。JetBrains 2026 年 7 月做过一次独立基准，把 Claude Code 挂上 rtk 跑真实任务，**成本中位数反而增加 7.6%**，和 60-90% 的宣传完全相反；Quesma 的分析同样得出基准对不上结论。HN 有个帖子标题就叫 "The Token Compression Illusion"，评论区推荐 headroom 的理由是它"在仓库里提供准确性基准，压缩的透明度更高"。有意思的是 rtk 的 README 现在自己改了口径：*"RTK cuts up to 90% of the bash output your agent reads. That is what RTK measures, and it is not the same as cutting your bill by 90%."*——压掉的输出 token 不等于省掉的账单，账单里还有系统提示、历史和缓存折扣。这个赛道甚至长出了反向工具：TokenTrust 是一个验证层，把 rtk/headroom 这类代理当真实进程跑，检查压缩有没有丢掉任务必需的内容、宣传的节省能否复现。一个赛道出现了专门的打假工具，本身就说明宣传数字该打折听。

## 路线二：headroom，在 API 传输层做代理
headroom 把代理架在 agent 和模型 API 之间（`ANTHROPIC_BASE_URL` 指过去），压缩面覆盖工具输出、日志、RAG 分块、文件内容甚至会话历史，口径 60-95%。两个不错的设计：原始内容本地保留可恢复（压缩错了有得救）；多 agent 共享同一份压缩上下文（Claude 和 Codex 并排跑时不用各压一份）。

社区口碑上 headroom 相对占优，理由就是上面那句"提供准确性基准、透明度更高"。但它的失效方式同样隐蔽：issue #746 记录 Claude Code 走这个代理后，原本的 deferred tool schemas（工具目录按需加载）行为失效，工具 schema 全量进上下文。传输层介入改了 agent 的自我优化行为，省下来的输出 token 可能被工具目录的增量吃回去。

## only-cc-lite：fork 只留压缩内核
only-cc-lite 是我从 headroom 抽出来的压缩库。动机：headroom 完整栈带着 ONNX Runtime、fastembed、HuggingFace tokenizers 这些 ML 依赖，而压缩内核本身是纯启发式的——JSON 数组 60-90%、日志按 ERROR/WARN 正则 50-80%、diff 40-60%。

fork 后零 ML 依赖，token 计数用字符密度估算（按模型族校准 chars/token），单函数调用就能嵌进 HTTP 代理中间层：

```rust
use only_cc_lite::{compress_request, Provider};
let (compressed, metrics) = compress_request(body, Provider::Claude);
```

这个 fork 给我一个判断：这类工具真正的资产是"哪些格式能压、怎么压"的规则库，不是模型。ML 依赖带来的语义能力，在这个场景的收益撑不起它的部署重量。

## 路线三：context-mode，在工具封装层
context-mode（本周 trending 上的项目）走得更激进：MCP server + hooks 拦截工具调用，输出先进沙箱，主 agent 拿到的是一份号称压缩 98% 的摘要。

机制上和前两条不是一个物种：工具输出先进本地 SQLite 的 FTS5 索引（分块 + BM25 排序 + Porter 词干化），主 agent 拿短摘要，要细节时自己检索存储。作者在 HN 的表述很准——它是"不让冗余进来，而不是进来之后再剪掉"，和压缩已有输出是两种哲学。98% 这个数字在社交媒体上到处在转，但注意口径：省的是"工具输出"的阅读，不是会话总账单。

代价有两层。信息层：主 agent 看不到索引外的细节，它甚至不知道自己漏了什么——格式压缩的错误是"少了几行"，摘要检索的错误是"结论就是错的"，后者不留痕迹。开销层：社区有用户实测发现它往每轮系统提示里注入约 15k token 的说明，轻负载下这部分能吃掉省下的量。每个走这条路线的工具都该被问一句：你的固定开销是多少？

## 三条路线对比
| 路线 | 拦截位置 | 保真度 | 失效方式 |
|---|---|---|---|
| rtk | 命令执行点 | 格式压缩，但可能改语义 | 误导性成功 |
| headroom | API 传输层 | 格式压缩 + 可恢复 | 干扰 agent 自身优化行为 |
| context-mode | 工具封装层 | 沙箱索引 + 按需检索 | 细节不可见且无感知，固定开销吃收益 |

我的实际组合：rtk 留给确定性的构建/测试输出（并接受要自己核对退出码），only-cc-lite 内核嵌在自己控制面的代理里，沙箱检索路线只用在搜索结果这种"按需取细节"的输出上。选择标准和压缩率无关，和"这段输出被压错时我能不能发现"有关。另外把所有宣传数字当待验证假设——JetBrains 对 rtk 的复测和 TokenTrust 这类验证层的出现说明，README 表格和真实账单之间有很宽的沟，自己跑一天真实任务比任何对比表可信。
