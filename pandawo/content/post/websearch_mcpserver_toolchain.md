---
title: "websearch-mcpserver 工具链：检索之外的三件套"
slug: websearch-mcpserver-toolchain
description: ""
date: 2026-09-12T09:19:18+08:00
lastmod: 2026-09-12T09:19:18+08:00
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
image: https://picsum.photos/seed/7a4e1ac3/800/600
---
# websearch-mcpserver 工具链：检索之外的三件套
------
> 上一篇写了聚合的四次重做（smartsearch 那条线）。这篇写剩下三个工具——academicsearch、cleanfetch、pdf_parser——和兜着它们的支撑件。单独一个 smartsearch 只解决"搜到"，agent 实际要的是闭环：搜到 → 打开 → 读进去，缺哪环都得自己手搓。

## 四个工具怎么分工
工具注册在 `mcp/server.go`，条件化注册 + 动态描述是两个通用设计：

- smartsearch：LLM 配了就注册带 `intent` 参数的版本（agent 声明检索目的换更准的结构化摘要），没配就注册无 intent 版
- cleanfetch：需显式启用才注册
- pdf_parser：默认关闭，工具描述按配置动态生成——配了 MinerU OCR 就多一句"扫描件可回退 OCR"，只配了 Token 就只说远程精准解析

动态描述这个点值得说一下：**agent 看到的工具描述永远和实际能力一致**，不会出现"描述说支持 OCR、实际没配 Token 调了报错"的错位。

## academicsearch：九引擎垂直线
学术检索是独立的一条垂直线：arXiv、PubMed、Europe PMC、DBLP、DOAJ、Crossref、Semantic Scholar、Google Scholar、OpenAlex 九个引擎并行，全部国内可直连或可代理。

评分在通用 Wigolo 之上叠学术特有信号，`pkg/search/academic_enhance.go`：

```go
// CiteFactor 引用数增强因子：对数压缩避免高引论文完全碾压，clamp 到 [1.0, 1.7]。
func CiteFactor(citedBy int) float64 {
	if citedBy <= 0 {
		return 1.0
	}
	f := 1 + math.Log2(1+float64(citedBy))*0.05
	if f < 1.0 {
		return 1.0
	}
	if f > 1.7 {
		return 1.7
	}
	return f
}
```

对数压缩 + clamp 这两个动作缺一不可：不压缩，一篇 Nature 引用 5 万次直接碾压所有结果；不 clamp，低引论文永远没有出头日。之外还有 JournalBoost（高影响力期刊/会议加性加分，大小写不敏感查表）、PDF 全文可用性、时效因子（时间敏感查询近一年 ×1.15）。

去重用 DOI + URL 双键合并——"一方有 DOI、一方只有相同 URL"的同文不合并是漏报重灾区，双键任一命中即视为同文。

对上游的防御分三层：403/429 指数退避（1.5s→3s 带随机抖动）并轮换桌面 UA；CAPTCHA（Google Scholar 的 /sorry 跳转）识别后不浪费重试直接报错；Semantic Scholar 带 Key 遇 429/503 退避，连续失败自动降级匿名模式。每家的 `time_range` 语法还各不相同（Crossref 用 `filter=from-pub-date:`、DOAJ 用年份闭区间、arXiv 用 UTC 时间戳区间），v3.4.0 把三家各修了一遍。

最后是错误透传：部分引擎失败不静默吞掉，失败引擎记入 `EngineErrors`，结果末尾提示"部分引擎本次失败，结果可能不完整"——agent 知道结果的置信度边界，比拿到一份看起来完整的半成品强。

## cleanfetch：抓取的降级链与安全边界
cleanfetch 解决"搜到了，打开看看"。抓取前先过两道安全闸：

1. **DNS rebinding 防护**：抓取前解析目标域名，检查所有解析出的 IP 是否内网/私有地址，和 go-webfetch 内部的 BlockPrivateIP 构成双重防护——agent 是会接受模型给的任意 URL 的，SSRF 面必须按"URL 不可信"设计
2. **HEAD 预检**：先看 Content-Length，超过 `max_fetch_size_mb`（默认 10MB）直接拒绝

抓取本体是三层降级：

```go
// 第一层：go-webfetch（无需代理）
result, err := webfetchInst.Fetch(ctx, params.URL)
if err != nil {
    out, ferr := fetchFallbacks(ctx, params.URL, err)  // Jina → 浏览器兜底
}
```

go-webfetch 用 tls-client 做 Chrome 131 TLS 指纹伪装（反爬的第一道坎是指纹不是 UA），失败回退 Jina Reader，再不行可选用户自备浏览器命令。关键是 `fetchFallbacks` 把每一层的失败原因聚合透传（`webfetch: ...; Jina: ...`）——agent 看得到"哪层为什么没成"，而不是一个笼统的 failed。

## pdf_parser：本地优先、AI 按需
PDF 解析走的是成本敏感的两段式：本地 PDF 库先抽文本（免费、毫秒级），抽不动（扫描件、图片型 PDF）才按需回退 MinerU OCR（要 Token、要上传、要等）。`pkg/webfetch/webfetch.go`：

```go
// 本地 PDF 文件：先本地 PDF 库抽文本，读不到再按需走 MinerU OCR
if strings.HasPrefix(rawURL, "file://") {
    localPath := strings.TrimPrefix(rawURL, "file://")
    // 处理 Windows 三斜杠格式 file:///C:/...
    ...
    return f.parseLocalPDF(ctx, localPath)
}
```

连 Windows 三斜杠的 `file:///C:/...` 都单独处理了——agent 给的路径格式从来不讲武德。大文档自动落临时文件而不是塞进工具结果，避免一次解析吃掉半个上下文窗口。

## go-webfetch：从项目里长出来的独立模块
网页抓取做到后来发现和搜索一样有通用价值，抽成了独立 Go module（`github.com/daidaiJ/go-webfetch`，v0.2.0）发布，主仓库按版本引用。这是这个项目第二次"长出独立资产"——第一次是把 server 包做成可嵌入模块。

## server 包：两种嵌入形态
`server` 包把整个服务做成可复用组件：

```go
srv := server.New()
srv.Run(*conf)    // 完整托管：引擎、MCP 路由、缓存清理协程、信号处理
handler := srv.Handler(*conf)  // 只要 http.Handler，嵌入已有服务的端口/TLS/中间件栈
```

配合引用计数 daemon（start/stop/kill/status，归零自动优雅退出）和 MCP hooks 的 SessionStart/SessionEnd，多会话共享实例、全关自动停。SearXNG 模式的路由也还留着——第一版没白做，它成了一个可选的引擎源。

## 发布矩阵
分发按三个渠道拆：GitHub Release 四平台二进制（linux/windows amd64 + darwin amd64/arm64）、GHCR 镜像（linux/amd64+arm64）、MCP Registry 的 mcpb 包。tag 约定是先打 `vX.Y.Z` 发 Release 推镜像，发完再单独补 `-registry` 后缀 tag 发 MCP Registry（钉同一 commit）——这个顺序是发坏一次学出来的，混在一起推会在 Registry 侧拿到还没构建完的产物。

## 小结
三个工具串起来是一条"搜到 → 打开 → 读进去"的闭环，每个环节都遵循同一套原则：降级链分层且错误透传、安全边界按"输入不可信"设计、贵的能力（OCR、LLM）永远放在按需位置。加上聚合篇的四版演进，这个项目到目前为止最有复用价值的可能不是任何一个具体引擎，而是这套"任何环节都会失败"的组织方式。
