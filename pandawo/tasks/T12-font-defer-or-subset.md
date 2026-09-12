---
id: T12
issue: I07
cost: medium
status: done
---

# 字体改为子集或延后加载

`extend-head.html` 对 jsDelivr 上整套 `lxgw-wenkai-screen-web@1.7.0` 做了 preload。

**改（选代价小的）**

1. 去掉 `rel=preload`，只保留 print+onload 异步 CSS；或
2. 换成只含常用汉字的子集 / 自托管 woff2；或
3. `media` 延后到 `requestIdleCallback` / 首屏后再插 link。

失败时系统字体栈要能显示。不必同时做 1+2。

**验收**

- 首页网络面板：首屏关键路径不再 preload 整套字族。
- 滚动后正文仍能切到霞鹜（若保留该字体）。
- jsDelivr 失败时页面可读。
