---
id: I06
priority: 6
benefit: medium
cost: low
status: closed
tasks: [T11]
---

# IndexNow 可能扫错 sitemap

`.github/workflows/seo-submit.yml` 用 `pandawo/public/zh-cn/sitemap.xml` 判断 URL 是否存在。单语言站点主 sitemap 通常在 `public/sitemap.xml`，默认语言不一定进子目录。对不上时变更文章会被 skip，定时提交空转。

**涉及**

- `.github/workflows/seo-submit.yml`
- `layouts/robots.txt`（声明的是根路径 sitemap.xml）

**验收**

- 对一篇自定义 slug 的文章跑一次 collect，能匹配到 `<loc>`。
- 脚本读取的 sitemap 文件与线上 `https://daidaij.github.io/sitemap.xml` 一致（或同时扫两份）。
