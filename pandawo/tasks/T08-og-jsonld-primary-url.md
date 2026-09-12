---
id: T08
issue: I05
cost: low
status: done
---

# OG 与 JSON-LD 使用真实封面 URL

爬虫不跑封面降级 JS，`og:image` / JSON-LD 仍是 frontmatter 的 picsum。

**改**

- `layouts/partials/head/extend-head.html`：JSON-LD `image` 用 `cover-remote` 的 `primaryUrl`（有 `.Params.image` 时）。
- 覆盖 Open Graph：站点级 `layouts/partials/head/opengraph/provider/base.html`，或在 extend-head 再写一条 `og:image`（确认不会双份冲突）。
- 无封面的页保持现状（`defaultImage.opengraph.enabled: false`）。

**验收**

- 主源为 met/unsplash 的文章，`og:image` 不是 `picsum.photos`。
- 与 `<img data-primary>` 的主 URL 一致。
