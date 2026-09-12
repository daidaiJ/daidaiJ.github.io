---
id: T17
issue: I10
cost: low
status: done
---

# 补齐 widgets.enabled

`hugo.yaml` 首页 widgets 含 categories，`widgets.enabled` 只有 search / archives / tag-cloud。主题用 enabled 决定是否加载资源时会漏 categories。

**改**

- `params.widgets.enabled` 加上 `categories`（以及 page 用的 `toc`，若主题要求）。
- 与 `widgets.homepage` / `widgets.page` 列表对齐。

**验收**

- 首页分类 widget 仍在。
- `hugo` 无 widget 相关 warn。
