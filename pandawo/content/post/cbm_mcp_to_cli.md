---
title: "给 MCP 服务器做减法（二）：从 MCP 退到 CLI 的 fail-loud 改造"
slug: cbm-mcp-to-cli
description: "给 MCP 服务器做减法（二）：把 cbm 从 stdio MCP 退回 CLI 的 fail-loud 改造，daemon 架构下如何消灭静默失败。"
date: 2026-09-06T20:05:43+08:00
lastmod: 2026-09-06T20:05:43+08:00
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
    - codegraph
    - cli
    - 工具链
image: https://picsum.photos/seed/a7855219/800/600
---
# 给 MCP 服务器做减法（二）：从 MCP 退到 CLI 的 fail-loud 改造
------
> 上一篇讲的是 token 账——cbm 和 codegraph 两件套的定义层税有 ~8,600 tokens/会话。这一篇讲更彻底的一刀：把 cbm（codebase-memory-mcp）整个从 MCP 进程形态退到 CLI 形态，以及退的过程中撞出来的 fail-loud 教训。数据都是本机实测（Windows 11，cbm v0.10.8，codegraph v1.6.0）。

## MCP 形态的固定成本：不只是 token
------
先看进程结构。MCP 形态下，cbm 是三层：

```mermaid
flowchart LR
    A[MCP 客户端] -- stdio, 每会话一个 --> B[stdio server]
    B -- IPC --> C[中心 daemon]
    C -- fork --> D[index worker 池]
```

这个结构意味着三笔固定成本，而且没有一笔能省掉：

1. **每会话拉起一个 stdio server**。只要有 N 个客户端连着，就有 N 份进程开销。上游 #1764 报的就是这个：空闲 MCP 客户端每个烧 ~0.7 核，N 会话 = N 核。
2. **daemon 冷启**。CLI 侧实测冷启一次 daemon 约 5 秒；MCP 侧更糟，上游 #1955 报新客户端要等 15-30s 才能连上健康 daemon。
3. **worker 的资源上限形同虚设**。我实测索引本仓库（~1900 文件的 C 项目）时 worker 吃到 **2.7GB 内存**（预算 2.8GB 几乎打满）、242s CPU；282MB 的单个 exe；stdio server 在空闲时段还平均烧 ~30% 单核。预算是 advisory 的（#1973），宁可 OOM 也不降级（#1997 报 14k 文件 monorepo 全量索引分配 ~11.5GB，无视配置）。

然后才是 token 账。cbm 的 MCP 定义层（tools/list + initialize.instructions + prompts）实测 ~5,850 tok，15 个工具 22.4KB；跟 codegraph 合计 ~8,600 tok/会话。而且 cbm 的结果还是**双份**返回——tree 文本 + structuredContent JSON，同一份数据塞两遍进上下文。

> 单看哪个数字都不致命，叠起来就是"我明明没怎么用它，它却一直在烧"的体感。最后那根稻草是 watcher，先看 2026-09-04 那次实测的完整账单：

| 指标 | 实测值 | 备注 |
|---|---|---|
| index worker 内存 | **2.7GB**（预算 2.8GB 几乎打满） | PID 1172，索引本仓库 |
| index worker CPU | 242s / 运行约 2 分钟 | ~21% 单核 |
| MCP stdio server CPU | 330+ CPU 秒 / 17 分钟 | 空闲时段平均 ~30% 单核 |
| 二进制体积 | **282MB** 单个 exe | cbm.zip 才 37MB |
| watcher 行为 | `strategy=git` 每 3~5 秒一轮 + 每轮 reap 一个 worker | 自触发重索引循环，#1953 |
| 同仓库 codegraph 对照 | 磁盘 1.1GB（db 160MB + **WAL 882MB**） | checkpoint 饥饿，与 cbm #1083 同款病 |

worker 触发链当时是实锤的：会话工具在仓库内写 `.codegraph/`、`graphify-out/`（未 gitignore、untracked）→ git-strategy watcher 判定 changed → daemon 反复 fork worker。这不是低概率 bug，是**默认配置的必然后果**——watcher 默认开、git 策略对 untracked 敏感、而工具产物恰恰就是 untracked 文件。上游四连发可以佐证这不是孤例：#1953 watcher 自触发、#2015 worker 失败无退避（有人 4h43m 里 fork 了 2233 个 worker）、#1083 WAL 无上限（有人跑出 115GB）、#1991 每请求 ~12ms 固定地板。

## 为什么裁剪在 MCP 侧做不干净
------
第一反应是裁工具面。cbm 支持 `--tool-profile=scout`，实测能从 argv 解析、立即生效，定义层 ~8.6K → ~5.8K tok。但往下走就发现问题了：

```text
档位 1  scout 配置        → 省 32%，零改动，但 15 个工具里只留一小撮
档位 2  自编译加 arch 档  → 要改 src/mcp/mcp.c 的 mcp_tool_allowed()，约 20 行
档位 3  退出 MCP 走 CLI   → 省 68%，15 个工具全部可用
```

档位 2 的尴尬在于：我想要的"arch 档"（get_architecture、query_graph、detect_changes、index_status、check_index_coverage、list_projects 这 6 个 codegraph 没有的工具）上游没有，得自己打补丁。而 cbm 0.10.x 几乎周更，上游自己的 profile 裁剪 PR（#1649 思路的 DACL 补丁）已经在冲突边缘——**大补丁 rebase 会痛，这是结构性问题，不是手艺问题**。

更隐蔽的是**配置漂移**。MCP 形态下 cbm 的行为散落在好几处：`_config.db`（藏在 cache 目录里，#1744 报升级会丢设置）、config.json、argv、daemon 启动时机。两个具体的坑：

```text
watcher_enabled        → 只在 daemon 启动时读，改完必须 daemon stop 再起
daemon 环境变量         → 被首个会话固化，后续会话无法按需调整
```

也就是说，就算工具面裁干净了，**运行时行为还是被"谁先启动谁说了算"的 daemon 固化**——每会话一个 stdio server + 中心 daemon 的三层结构里，daemon 环境被第一个连上来的会话定型，后面的人只能接受。

> 这是我最终选档位 3 的真正原因：不是 token 省 68% 有多诱人，而是 MCP 形态下"裁剪"永远是在别人的进程模型里打补丁。CLI 形态下，进程模型是我的，每次调用都是干净的一次性子进程，没有固化、没有漂移。

## 退到 CLI：全量 15 个工具，选择权交给 skill
------
形态变化一句话：cbm 不再注册为 MCP server，改用

```bash
codebase-memory-mcp cli --json <tool> [args...]
```

按需子进程调用。它有个很方便的性质：**每个 MCP 工具都有 CLI 等价物**，所以"裁剪"这个概念直接消失了——15 个工具全量可调，一个不少，也就不存在"profile 裁不干净"的问题。工具面不再占据每个会话的上下文，调用时才产生成本。

定义层的账当场就变了：

| 组合（定义层） | ≈ tokens/会话 | 相对两件套 |
|---|---|---|
| cbm MCP + codegraph MCP（现状） | ~8,600 | — |
| cbm scout 档 + codegraph | ~5,840 | 省 32% |
| cbm arch 补丁档 + codegraph | ~4,550 | 省 47% |
| **cbm 退 CLI，仅 codegraph 进 MCP** | **~2,750** | **省 68%** |

而且 bytes/4 是乐观估算——schema 是标点密集的 JSON，真实分词约 bytes/3~3.5，两件套体感可能到 ~10-11K tokens。CLI 形态下这笔税直接归零。

代价是模型看不到工具列表了，"什么时候用哪个命令"得有人管。我的方案是用 skill 规约约束，而且刻意收得很窄——只保留三个实测有效的场景，其余一律禁用：

| 场景 | 命令 | 为什么留给 cbm |
|---|---|---|
| 架构概览 | `cbm cli get_architecture`（aspects=clusters/cycles/hotspots） | cbm 独有，codegraph 无架构视图 |
| 图查询 | `cbm cli query_graph`（Cypher、复杂度门槛） | cbm 独有 |
| commit 影响半径 | `cbm cli detect_changes`（git diff → 传递影响集） | diff 基，codegraph 的 impact 是符号基 |

规约里还给三类典型工作流定了调用法：

```text
开源调研    clone 后 codegraph init + index（一次全量，之后增量自动）；
            cbm 只在确定要做架构级分析时 index_repository mode=full（语义边只有 full/moderate 有），
            用完 daemon stop；大仓（>1 万文件）用 mode=fast 先垫底。
            引用代码前必跑 check_index_coverage——parse_partial 区域的图结果不可信。

二次开发    日常 impact/callers 走 codegraph；提交前跑一次 cbm detect_changes 当"影响面自检"，
            配合 query_graph 查改动的传递调用深度。
            cbm watcher 关掉（#1953），索引新鲜度靠提交前手动 index。

自研项目    仓库 < 几千文件时 codegraph 一个就够；cbm 只做里程碑体检
            （get_architecture aspects=cycles,hotspots 查循环依赖和上帝节点）。
```

配套的索引分层原则也写进了规约：

```text
codegraph = 活层（always-on，保存 ~0.3s 增量，喂日常符号工作）
cbm       = 深层（milestone / 按需全量，喂架构分析与影响面，用完 daemon stop）
```

会话开始时 hook 自动 init/sync，我不手动管索引；cbm 只在确定要做架构级分析时 `index_repository` 一次，用完 `daemon stop`。产物目录（`.codegraph/`、`.codebase-memory/`）一律 gitignore，防 watcher 互喂。

> 这里有个反直觉的取舍：CLI 化之后单次冷启 daemon 要 ~5 秒，比 MCP 常驻"慢"了。但对一个每会话只按需调两三次的深层工具，5 秒 × 2 次 < 常驻进程烧掉的一切——包括那个 watcher 死循环和 2.7GB worker。低频工具的合理形态就是一次性子进程，不是常驻服务。

## fail-loud：静默空结果比报错更危险
------
CLI 化过程中最值钱的教训是这个：**工具返回"空结果"有两种可能——真的没有，或者工具坏了**。MCP 形态下这两者都表现为一个正常的响应，模型根本分不清。三个实锤案例（记载在我的环境备忘里，均为实测）：

**案例一：upstream #1682。** CALLS 边丢失时，`trace_path` 返回 `callers_total: 0`——和"这个函数真的没有调用方"在响应格式上**完全不可区分**。我一开始信了图谱的"没有调用方"，后来 grep 复核才发现调用方明明存在。

**案例二：`detect_changes` 对非法 direction 静默返回空。** 传错参数不报错，返回一个空的影响集。影响面自检场景里，"空"意味着"这次改动无风险"——把工具错误翻译成了错误的安全结论。

**案例三：`since` 参数拒收 `^` 后缀。** 传 `v1.0^` 直接被拒。这算好的，好歹是个显式失败——但如果不看退出码，管道里它同样表现为"空"。

```text
危险的共同模式：
  输入非法 / 内部状态损坏
    → 静默返回空集
      → 模型把"空"读成"事实上的不存在"
        → 下游结论全错，且无任何报错痕迹
```

防御手段我总结成三条，全部写进了 skill 规约：

1. **否定性结论必须 grep 复核**。"没有调用方/没有引用"这类结论，图谱零结果不可信——静默漏报与真实无调用不可区分，先 grep 原文再下结论。
2. **批量修改必须带断言**。用脚本补丁改配置时 `assert count == 1`，失败即整体回滚。我实际靠这个救回过两次——python 补丁锚点缩进错误，把一批配置键插进了错误的嵌套层级（比如插到 `themeVariables.xyChart` 内部），键"存在"但静默失效。批量改配置结构后还要用括号深度计数脚本断言键的层级，或者干脆整段重写而不是锚点替换。
3. **黑名单 + 全量审计代替打地鼠**。检测的"坏值清单"必须有定义来源（比如主题调色板全集），只列已知坏值会漏掉"自家配置被误用"这类新形态。正确姿势是先渲染全部形态 → 像素级/结构级普查 → 对照定义来源全集，一次扫完，而不是发现一个修一个。

把这三条合在一起，就是 skill 规约里给所有图谱类工具定的防呆前置：

```text
调图谱工具前：  index_status 确认索引新鲜度（索引落后时 detect_changes 结果失真）
调完拿结论前：  结论是"空/没有/零" → 强制 grep 复核，禁止直接采信
写脚本改配置：  assert count==1 + 层级断言，失败即整体回滚
```

> 这三条没有一条是 cbm 特有的——任何"返回结构化结果"的工具都适用。图谱只是把问题放大了，因为它看起来太可信了：返回带行号、带符号名的精确结果，模型（和我）都倾向于直接信。

有意思的是，这个原则直接催生了 fork 补丁计划里的 #4：给 cbm 加**配置化工具禁用清单**（tools_disabled，双侧生效），要求禁用必须 fail-loud——调用被禁的工具要显式报错而不是静默失败，且 `--help` 输出与实际工具面一致。禁用一个工具后它还能被调用、或者 help 里还列着，都是配置漂移的静默形态。

> fail-loud 说白了就一句话：宁可让错误炸在这一层，也不要让它变成一层之下的"空结果"。静默空结果最阴险的地方在于它**消耗的是信任而不是报错**——你不会去排查一个"正常"的空响应。

## Windows 的 DACL 仪式
------
CLI 化没解决的一个问题：cbm 在 Windows 上对 daemon endpoint 做强制 ACL 检查（上游 #1624/#1856/#2023 的 ACL 设计），撞上时直接报 `secure daemon endpoint could not be created`。

我踩过的绕法，按代价排序：

```bash
# 1. 搬运行时目录（官方思路，但只能搬家不能豁免检查本身）
CBM_RUNTIME_DIR=D:\data\codebase-memory-mcp\runtime

# 2. 临时绕过：收紧目标目录 ACL 让检查通过（D:\data 这么干过，事后要 icacls /reset 恢复）

# 3. fork 补丁计划 #2：加 CBM_SKIP_DACL_HARDENING 开关
```

#2 的关键是：CLI 形态**同样**受 DACL 检查拖累——退到 CLI 躲开了 MCP 的进程结构税，但躲不开单机安全检查对本地回环通信的开销。`CBM_RUNTIME_DIR` 只是把战场挪走，检查本身还在跑。所以补丁计划里专门立了 #2：一个显式的跳过开关，本地单人场景没必要每次都做安全仪式。

> 这类问题在 Linux 上根本不存在，纯 Windows 单机税。但代价结构很典型：**设计给多用户/低信任场景的防御，在单用户高信任环境里变成每个请求都要交的过路费**。和 MCP 工具面裁剪是同构的——都是"默认配置为我不存在的场景付费"。

## fork 补丁计划：把教训变成 issue
------
最后整理一下 fork 仓库的 issue 清单。写出来是因为每一条背后都是上面某一节的一个教训：

| # | 内容 | 状态 |
|---|---|---|
| #1 | CLI 方案取代 profile 裁剪 | **已关闭**——直接退 CLI，profile 档位没了存在必要 |
| #2 | `CBM_SKIP_DACL_HARDENING` 开关 | 待做——CLI 侧同样受检查拖累 |
| #3 | 默认值反转 | 待做——已补 CLI 侧证据：daemon 冷启 ~5s/次、detect_changes 非法 direction 静默空、since 拒收 `^` |
| #4 | 配置化工具禁用清单（tools_disabled 双侧生效 + fail-loud + `--help` 一致性） | 待做——挡住实测判负的 5 个工具被误用 |

补丁纪律沿用之前定下的：**机械、小、可重放**。上游几乎周更，#1649 已经在冲突边缘，任何超出"加一组名字/加一个开关"粒度的补丁都是给未来的自己挖坑。

值得单独说的是 #1 被关闭这个信号：最初计划里"给 MCP 加更好的 profile 档位"是正经理方案，做着做着发现 CLI 形态让整个问题消失了。**最好的裁剪是不需要裁剪**——工具面从来不进上下文，就无所谓留哪 6 个砍哪 9 个。

## 这套退法在整体方案里的位置
------
退 CLI 不是孤立动作，它是一个分层方案的地基。完整规划是三步：

```text
P0  只包 codegraph 进 MCP（4 个短工具：search / source / relations / impact）
P1  CBM 保持 CLI 按需调用——本文讲的退法就是这一步的落地
P2  仅当"出会话跑 CLI"摩擦大到不可接受，才在门面里延迟拉起 CBM 三个工具
    （第一次调用才 spawn cbm cli，空闲超时 daemon stop）
```

配套的验收清单里，几条硬指标直接针对 MCP 形态的老病：

```text
- 会话 tools/list 工具数 ≤ 8，描述合计 ≤ 4KB（对 ~22.4KB 的 cbm 全量）
- 日常 search/source/relations/impact 不启动 cbm.exe / cbm daemon
- 结果无双份 JSON（cbm 的 tree + structuredContent 双份是重点封杀对象）
- 需要架构分析时有文档化的 CLI 一步（含 daemon stop）
```

同样重要的是"明确不做"清单：不给 cbm 关 LSP、拆 daemon、硬内存上限——那是敌对 fork，和周更上游打架。改不动的地方绕过去（CLI、CBM_RUNTIME_DIR），绕不过去的立 issue（#2/#3/#4），这就是补丁计划全部是"开关级"改动的原因。

------
> 复盘下来，"从 MCP 退到 CLI"与其说是性能优化，不如说是一次责任边界的回收：进程模型、调用时机、失败语义，全部收回到我自己的 skill 规约里。代价是我要自己维护规约、自己复核否定性结论。但考虑到静默空结果曾经让我把"图谱说没有调用方"当成事实写进结论——这笔交易不亏。
