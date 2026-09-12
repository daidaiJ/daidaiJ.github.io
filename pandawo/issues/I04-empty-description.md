---
id: I04
priority: 5
benefit: high
cost: medium
status: closed
tasks: [T09, T10]
---

# 大量文章 description 为空

至少二十多篇 `description: ""`。OG、JSON-LD、搜索摘要退回正文截断，技术文常截到代码块。archetype 也预置空字符串，新文会继续这样。

**涉及**

- `archetypes/default.md`
- `content/post/*.md`（空 description 的篇目）
- `layouts/partials/data/description.html`（已有清洗，补不上空字段）

**验收**

- 新文 archetype 不再生成空 description。
- 近一年（或首页能翻到的）文章有 1–2 句中文摘要。
- 抽查一篇的 `og:description` 不再以代码开头。
