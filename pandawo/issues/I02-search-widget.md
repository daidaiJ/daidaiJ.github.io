---
id: I02
priority: 2
benefit: high
cost: low
status: closed
tasks: [T03]
---

# 侧栏搜索表单实际不可用

`content/page/search/index.md` 设了 `build.list: never`，搜索页不进 `.Site.Pages`。主题 widget 用 `where Pages "Layout" "==" "search"` 找不到页，每次构建 `Search page not found`，首页右侧没有搜索表单。`render: always` 只保证 `/search/` 路由还在。

**涉及**

- `content/page/search/index.md`
- `themes/hugo-theme-stack/layouts/partials/widget/search.html`

**验收**

- `hugo` 不再出现 Search page not found。
- 首页右侧出现可用搜索表单，能跳到 `/search/` 并出结果。
