---
id: T01
issue: I01
cost: low
status: done
---

# 首页非首张封面改为 lazy

`header.html` 被文章页和首页列表共用，6 张封面都 eager + high。

**改**

- `layouts/partials/article/components/header.html`
- 按 `.Page.Kind` / 是否列表：文章页保持 eager+high；列表仅第一项 high，其余 `loading=lazy`、去掉 fetchpriority。
- 第一项可用 `{{ if eq .Scratch }}` 或列表循环下标；若 header 拿不到下标，给 `cover-img` / header 加 `loading`、`priority` 参数，由 `article-list/default` 覆盖传入。

**不要改** 主题 `article-list/default.html`（尽量站点级覆盖）。`tile.html` 已 lazy。`compact.html` 远程封面目前 eager，若归档/相关列表会用到，一并改 lazy。

**验收**

- 首页 HTML：第一张 `fetchpriority="high"`，其余 `loading="lazy"` 且无 high。
- 文章页头图仍 eager + high。
