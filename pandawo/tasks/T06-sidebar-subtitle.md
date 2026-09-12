---
id: T06
issue: I03
cost: low
status: done
---

# 去掉 Lorem ipsum 副标题

`hugo.yaml` 根级 `params.sidebar.subtitle` 仍是 Lorem ipsum；语言块里才是「潘达张的个人博客」。JSON-LD / 侧栏可能吃到根级。

**改**

- 根 `params.sidebar.subtitle` 改成与语言块一致的中文，或删掉根级让语言块生效。
- 对照构建产物里侧栏和 `<script type="application/ld+json">`。

**验收**

- 页面源码不再出现 `Lorem ipsum dolor sit amet`。
