---
id: I07
priority: 7
benefit: medium
cost: medium
status: closed
tasks: [T12]
---

# 霞鹜文楷全包拖带宽

每页从 jsDelivr preload `lxgw-wenkai-screen-web@1.7.0` 整套 CSS。样式已异步，字体文件仍常到数百 KB～1MB+，和封面抢带宽。国内 jsDelivr 也不稳。

**涉及**

- `layouts/partials/head/extend-head.html`
- `layouts/partials/footer/components/custom-font.html`（已清空 Google Fonts）

**验收**

- 首屏不再阻塞拉取完整字族；或仅子集常用汉字/自托管。
- 文章正文仍能用到霞鹜（可滚动后再换装）。
- 字体 CSS 失败时系统字体栈正常显示（已有 noscript，需确认 onload 失败路径）。
