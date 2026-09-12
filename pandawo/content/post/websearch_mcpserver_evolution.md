---
title: "websearch-mcpserver 复盘：聚合为什么重做了四次"
slug: websearch-mcpserver-evolution
description: ""
date: 2026-09-12T09:19:17+08:00
lastmod: 2026-09-12T09:19:17+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories:
    - 技术笔记
    - ai
    - go
tags:
    - mcp
    - 搜索引擎
    - go
image: https://picsum.photos/seed/e268d8e8/800/600
---
# websearch-mcpserver 复盘：聚合为什么重做了四次
------
> 自建检索服务 2026-03-20 init，六个月 78 个 commit，Go 实现。聚合设计重做了四次，没有一次是计划好的——每次都是撞上一个靠不住的东西才动手。这篇按"是什么靠不住"组织，同时把核心模块的真实实现放进来：引擎接口、KeyPool、apipool、Wigolo 评分管线。工具链的三件套（academicsearch / cleanfetch / pdf_parser）另成一篇。

## 前提：三个约束
1. 国内网络下 Tavily/Exa 这些商业 API 时通时断，Google/DDG 直连基本没戏，代理还得自动检测
2. agent 检索是高频操作，付费额度烧得飞快，手里只有各家散落的免费额度
3. 搜索结果对 agent 不友好（无摘要、无元数据、条数失控）的话，一次检索吃掉半个上下文窗口

## 第一版重做：聚合器靠不住
第一版接 searxng，聚合、去重、排序都现成，我只写 MCP 接口的壳。但它把三样东西锁死了：多一个实例的运维、上游引擎在国内的可达性、排序黑盒没法按 agent 场景定制。

结论：聚合逻辑是这个项目唯一的核心竞争力，不能外包。于是有了后面所有版本的地基——

## 地基：一个 4 方法的引擎接口
所有引擎（百度、Bing、Google、DDG、Tavily、Exa、AnySearch、豆包、9 个学术引擎）实现同一个接口，`pkg/search/inf.go`：

```go
type SearchInf interface {
	Name() string
	Search(query string) (string, error)              // 聚合后的文本结果（喂模型）
	SearchRaw(query string) ([]SearchResult, error)   // 结构化结果（进评分管线）
	MergeContent(query string, results []SearchResult) (string, error)
}
```

接口刻意做小，引擎差异靠两个机制吸收：可选能力用单独的小接口（时间范围是 `SearchTimeRanger`，实现了才有；豆包的 Custom 端点实现了它）；各家 score 不可比的问题不管——结构化结果只带原始排名，可比性留给评分管线。

后面加一个引擎的成本是：写一个文件 + factory 一行注册。这个地基决定了后面三次重做都不用推倒接口层。

## 第二版重做：单家引擎靠不住
直连各引擎自己聚合（`e74e427`、`f0d9a33`、`5890e66`）。多引擎并发、单家失败不阻塞；降级链成型：每个模式主引擎失败自动回退，无 Key 自动降级免费引擎。降级链不是容错补丁，是产品形态本身。

## 第三版重做：免费额度靠不住 —— KeyPool + apipool
手里散着 anysearch、百度千帆、Tavily、Exa、豆包的 Key，每家免费额度单用不够烧。apipool 每次只调一个供应商，失败自动切换，同一供应商内先试完所有 SK 再换下一家。

两个实现细节值得展开。

**KeyError 精确失效**。请求失败时要标记"刚才用的那个 Key"失效，但错误在多层传播后容易把 Key 带进日志。实现是一个专用的 error 包装，`pkg/search/apipool.go`：

```go
// KeyError 携带请求失败时实际使用的 API Key，供 apipool 精确标记失效。
// 注意：Error() 不输出 Key 本身，避免 API Key 泄漏到日志。
type KeyError struct {
	Key string
	Err error
}

func (e *KeyError) Error() string {
	if e.Err == nil {
		return "key error"
	}
	return e.Err.Error()
}
```

**KeyPool 冷却自愈**。Key 失效不是永久的（限流、欠费都会恢复），所以不是删掉而是打 30 分钟冷却戳，`pkg/search/keypool.go`：

```go
// 轮转游标原子递增，跳过冷却中的 key
for i := uint64(0); i < n; i++ {
	idx := (p.idx.Add(1) - 1) % n
	if p.states[idx].invalidUntil.IsZero() || now.After(p.states[idx].invalidUntil) {
		p.states[idx].invalidUntil = time.Time{}
		return p.keys[idx]
	}
	...
}
// 全部失效，返回最早恢复的那个（不等待）
```

轮转指针原子递增，冷却到期的 key 自动回池；全部失效时返回最早恢复的那个而不是直接报错——配合百度网页搜索兜底，池子任何情况下不空转。weighted 策略下供应商有效权重 = 配置权重 × 当前可用 SK 数，Key 冷却权重自动下降、恢复自愈。

## 第四版重做：混合结果靠不住 —— Wigolo 管线
hybrid 模式全引擎并发后，新问题是 9 个引擎的结果混在一起，转载站、镜像站、SEO 农场霸屏。这条线最终长成了完整的本地评分管线，全程纯启发式——搜索本身不能再引入一次 LLM 调用的成本和延迟。

编排层 `HybridSearchImpl` 支持按引擎配置过滤：每个引擎可以单独设最低分、单引擎条数上限、引擎权重（影响 RRF 融合分）：

```go
type engineFilter struct {
	minScore float64 // 最低相关性分数，0 = 不过滤
	maxSize  int     // 单引擎最大结果数，0 = 使用默认值
	weight   float64 // 引擎权重，影响 RRF 融合分，0 = 默认 1.0
}
```

核心是 RRF（Reciprocal Rank Fusion），`pkg/search/enhance.go`：

```go
const rrfK = 60.0

func RRFScore(ranks map[string]int, K float64) float64 {
	var score float64
	for _, rank := range ranks {
		score += 1.0 / (K + float64(rank))
	}
	return score
}
```

只比排名不比分数——第二版做过分数归一化，但各家 score 口径永远做不齐，RRF 从根上绕开。融合之上叠四层信号：

1. **词汇对齐**：查询词与标题/内容的词级匹配，停用词表是中英混合场景自己攒的（连 latest/current 这种检索场景特有的口水词都进去了），稀有词和连续短语加权
2. **域名品质惩罚**：品牌/电商/词典站误匹配降权（独立成 `enhance_domain.go`）
3. **共识/权威/时效加分**：多引擎都返回的结果天然更可信，`ConsensusBoost` 按引擎数加性加分
4. **低分阈值过滤 + MMR 贪心重排**：Token Jaccard 相似度，把转载站和同源博客打散

学术侧是同一套思路的变体，放到工具链那篇细说。

## 检索之上：意图、摘要与缓存
smartsearch 的 LLM 集成是可选的，注册逻辑跟着配置走：LLM 开着就注册带 `intent` 参数的版本——agent 可以声明检索目的（查资料/找代码/看新闻），后端按意图调摘要策略；没配 LLM 就注册无 intent 版本，功能不缺。

流式摘要的降级链：LLM 流式摘要失败 → 非流式摘要 → 原始结果直接返回。摘要永远不是必需品，是锦上添花。

缓存用 SQLite（modernc.org/sqlite 纯 Go 驱动，不引 CGO，单二进制能保住），WAL 模式，6 小时过期按最近命中时间算，30 分钟定时清理，学术和非学术结果按参数区分防混用。缓存查询异常就跳过缓存直接搜——缓存也是会坏的，它坏不能拖累主链路。

## 一直都在的暗线：网络环境靠不住
散落在所有 commit 里的一条线。系统代理检测做了三层：Windows 注册表（ProxyEnable/ProxyServer）+ WinHTTP + 环境变量，后台 30 秒轮询，`DynamicProxyTransport` 请求级动态解析——Clash/V2RayN 开关系统代理不用重启服务，下一个请求自动跟上。加上 DDG 仅在代理可用时进引擎池、Google 默认禁用、Google Scholar 403/429 指数退避加轮换 UA、CAPTCHA 识别后直接报错不浪费重试、arXiv 内置 1 req/s 限流器。

结论：引擎可用性不是布尔值，是"在哪个网络环境下"的函数，配置里每个开关背后都是一次实测。

## 无状态开关
2026-07-28 MCP 规范修订把无状态定为方向，8 月底的 v3.2.1（`f46b091`）跟着加了 `mcp_stateless` 开关：每个 POST 独立处理，免 initialize 握手与 `Mcp-Session-Id`，GET SSE 长连直接 405。对这个服务改造成本为零——工具全是请求-响应式，会话本来就用不上。

## 复盘小结
四次重做不是互相推翻，是上一版把某类问题解决干净后暴露出下一类。这个项目对"失败"的处理已经形成固定套路：引擎失败有降级链、Key 失败有冷却池、供应商死光有百度兜底、摘要失败回退原始结果、缓存坏了跳过——设计里没有假设任何东西可靠。工具链的三件套（academicsearch / cleanfetch / pdf_parser）和安全设计在工具链篇。
