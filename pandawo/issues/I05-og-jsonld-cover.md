---
id: I05
priority: 4
benefit: medium-high
cost: low
status: closed
tasks: [T08]
---

# OG / JSON-LD 封面仍是 picsum

页面封面已按 seed 打散到 Met / Unsplash / picsum，爬虫不跑 JS。`og:image` 走 `helper/image` 的 frontmatter 原链，JSON-LD `image` 同样是 `.Params.image`（picsum）。分享卡片和搜索里的图与用户看到的不一致。

**涉及**

- `layouts/partials/head/extend-head.html`
- `themes/hugo-theme-stack/layouts/partials/head/opengraph/provider/base.html`（需站点级覆盖）
- `layouts/partials/helper/cover-remote.html`

**验收**

- 文章页 `og:image` 与 JSON-LD `image` 等于构建期 `primaryUrl`。
- 非 picsum 主源的文章，分享预览不再是 picsum。
