---
id: T10
issue: I04
cost: medium
status: done
---

# 给近期文章补中文摘要

空 `description: ""` 会让 OG/摘要截到正文（常是代码）。

**改**

- 优先首页能翻到的、以及近一年 `content/post/*.md`。
- 每篇 1–2 句中文，说清文章在讲什么，不要贴代码。
- 更早的篇目可另开一轮，不必一次填完。

**验收**

- 抽 3 篇近期文：`og:description` 是人话摘要。
- 未改动正文与封面。
