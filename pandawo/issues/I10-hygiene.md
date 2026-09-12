---
id: I10
priority: 10
benefit: low
cost: low
status: closed
tasks: [T15, T16, T17]
---

# 模板与内容卫生

几处不影响主路径、但会误导后续改动：

- `layouts/partials/footer/extend-footer.html` 主题未引用，与 `footer/custom.html` 的 Mermaid 注入重复且 theme 默认值不一致。
- `opensandbox_pool_churn` 与 `ctx_lean_1_pipeline` 封面 seed 同为 `a1d6f19c`。
- `hugo.yaml` 的 `widgets.enabled` 只有 search/archives/tag-cloud，和首页实际用的 categories 对不齐。

**涉及**

- `layouts/partials/footer/extend-footer.html`
- `layouts/partials/footer/custom.html`
- `content/post/opensandbox_pool_churn.md`
- `content/post/ctx_lean_1_pipeline.md`
- `hugo.yaml`

**验收**

- 只保留一份 Mermaid 注入。
- 上述两篇封面 URL 主源或 seed 不同。
- `widgets.enabled` 与 homepage/page 实际 widget 列表一致。
