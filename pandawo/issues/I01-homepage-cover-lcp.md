---
id: I01
priority: 1
benefit: high
cost: low
status: closed
tasks: [T01, T02]
---

# 首页封面抢 LCP

首页 `article-list/default` 复用文章头图 partial，6 张远程封面都是 `loading=eager` 且 `fetchpriority=high`，互相抢首屏。卡片展示高度只有 150–305px，却拉 800×600。

**涉及**

- `layouts/partials/article/components/header.html`
- `layouts/partials/article/components/cover-img.html`
- `layouts/partials/article-list/default`（主题，经 header 间接）

**验收**

- 首页只有第一张封面 `fetchpriority=high` + eager，其余 lazy。
- 列表用的图不大于展示所需（或由 CDN 参数缩小）。
- 文章页头图仍 eager + high。
