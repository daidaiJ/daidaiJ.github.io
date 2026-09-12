---
id: T03
issue: I02
cost: low
status: done
---

# 让搜索页进入 Site.Pages

`content/page/search/index.md` 的 `build.list: never` 让 widget 找不到 Layout=search 的页。

**改**

- 把 `list: never` 改成 `list: local`（或不写 list，默认即可）。
- 保留 `outputs: [html, json]` 和 `render: always`。
- 不改主题 `widget/search.html`。

**验收**

- `hugo` 无 `Search page not found`。
- 首页右侧有搜索框，提交到 `/search/`，JSON 索引能出结果。
