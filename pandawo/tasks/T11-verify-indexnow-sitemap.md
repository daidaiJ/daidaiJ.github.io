---
id: T11
issue: I06
cost: low
status: done
---

# 核对 IndexNow 用的 sitemap 路径

`.github/workflows/seo-submit.yml` grep `pandawo/public/zh-cn/sitemap.xml`。单语言站主文件在 `public/sitemap.xml`，`robots.txt` 也指向根路径。

**改**

- 本地 `hugo` 看 `public/` 实际 sitemap 路径。
- collect 步骤改读真实文件；若两份都有，两份都扫。
- 自定义 slug 的文章至少测一条能匹配 `<loc>`。

**验收**

- workflow 在「有新文」时不再因路径 miss 而 skip。
- 与线上 `https://daidaij.github.io/sitemap.xml` 一致。
