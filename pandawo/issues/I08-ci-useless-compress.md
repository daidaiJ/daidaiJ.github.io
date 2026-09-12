---
id: I08
priority: 8
benefit: low-medium
cost: low
status: closed
tasks: [T13]
---

# CI 压缩对 Pages 无效

`gh-pages.yml` 在构建后跑 optipng/jpegoptim，再给 html/css/js 生成 `.gz` / `.br`。封面是远程图，`public` 里几乎没有可压的位图。GitHub Pages 的 Fastly 会现场压缩，仓库里的预压缩文件不会带 `Content-Encoding`，只拖长 Action。

**涉及**

- `.github/workflows/gh-pages.yml`

**验收**

- 部署 workflow 不再安装 optipng/jpegoptim/brotli，不再 find+gzip。
- 线上 HTML/CSS 仍由 Pages 压缩（DevTools 看 `content-encoding`）。
