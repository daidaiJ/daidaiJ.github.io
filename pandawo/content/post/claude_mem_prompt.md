---
title: "Claude_mem_prompt"
slug: "mem_prompt"
description: "总结claude mem 插件中用到的提示词"
date: 2026-02-28T13:41:14+08:00
lastmod: 2026-02-28T13:41:14+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: [""]
tags: ["golang"]
image: https://picsum.photos/seed/a62a1464/800/600
---

# claude mem 提示词总结笔记

> 年后回来比较忙，今天才有一点时间总结一下假期对claude mem 的上下文管理研究

claude mem 对上下文的管理主要是分成两部分：
- 总结 summary 让llm 自身对上下文做提炼，获取一个精炼的内容摘要
- 渐进式检索，通过summary 和会话的id 顺序，获得前后关联内容

## summary 部分
```xml
PROGRESS SUMMARY CHECKPOINT
===========================
Write progress notes of what was done, what was learned, and what's next. This is a checkpoint to capture progress so far. The session is ongoing - you may receive more requests and tool executions after this summary. Write \"next_steps\" as the current trajectory of work (what's actively being worked on or coming up next), not as post-session future work. Always write at least a minimal summary explaining current progress, even if work is still in early stages, so that users see a summary output tied to each request.

Claude's Full Response to User:
${lastAssistantMessage}

Respond in this XML format:
<summary>
  <request>[捕捉用户请求和讨论/完成内容实质的简短标题]</request>
  <investigated>[到目前为止探索了什么？检查了什么？]</investigated>
  <learned>[你了解到了什么工作原理？]</learned>
  <completed>[到目前为止完成了什么工作？发布或更改了什么？]</completed>
  <next_steps>[在此会话中，你正在积极处理或计划接下来处理什么？]</next_steps>
  <notes>[关于当前进度的其他见解或观察]</notes>
</summary>

IMPORTANT! DO NOT do any work right now other than generating this next PROGRESS SUMMARY - and remember that you are a memory agent designed to summarize a DIFFERENT claude code session, not this one.
Never reference yourself or your own actions. Do not output anything other than the summary content formatted in the XML structure above. All other output is ignored by the system, and the system has been designed to be smart about token usage. Please spend your tokens wisely on useful summary content.
Thank you, this summary will be very useful for keeping track of our progress!
LANGUAGE REQUIREMENTS: Please write ALL summary content (request, investigated, learned, completed, next_steps, notes) in 中文
```
可以看到整个提示次的结构可以分成四部分：
1. 意图，也就是目标
2. 待处理内容
3. 输出示例
4. 输出形式约束

# 上下文管理的相关思考
## claude mem 的三级结构
1. 索引，可以理解为字段检索，根据持久化上下文中的元信息
2. 上下文也就是摘要相关的内容
3. 全量的原始会话
   
目前claude 通过记录和压缩历史上下文，能够让长期项目在会话启动时收益，避免预先加载大量上下文，算是一种瘦身，另外尚有一种在测试的endless 模式，通过拦截替换工具调用的上下文，整理历史会话，避免多轮对话+ 多次工具调用带来的上下文膨胀问题，节省token。

另外可以通过减少工具/tool search/skill 渐进式加载等方式在工程上缓解这个问题，其实子智能体subAgent 通过隔离上下文，可以和上述的技术结合起来改善上下文问题

## TODO
学习研究pageindex 的递归树式上下文管理，思考如何在seekdb 这类至少可以支持BM25+向量混合检索的数据库上实现这类模式