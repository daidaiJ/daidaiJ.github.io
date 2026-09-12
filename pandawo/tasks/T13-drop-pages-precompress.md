---
id: T13
issue: I08
cost: low
status: done
---

# 去掉 Pages 用不上的 CI 压缩

**改**

- `.github/workflows/gh-pages.yml`：删除 apt 安装 optipng/jpegoptim、find png/jpg 压缩、html/css/js 的 gzip/brotli 生成。
- 保留 hugo 构建与 `peaceiris/actions-gh-pages` 发布。

**验收**

- Action 时长下降，产物无成批 `.gz`/`.br`。
- 线上 HTML 仍有 `content-encoding: gzip` 或 br（Fastly）。
