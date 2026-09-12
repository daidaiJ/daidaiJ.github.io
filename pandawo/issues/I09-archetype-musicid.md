---
id: I09
priority: 9
benefit: low-medium
cost: low
status: closed
tasks: [T14]
---

# 新文默认挂音乐播放器（已关闭：by design）

> **2026-09-12 决定**：音乐贴片是站点特色，新文保留默认 `musicid: 5264842`，不改为按需选配。

`archetypes/default.md` 写死 `musicid: 5264842`。每篇新文文章头下都有「点击加载音乐播放器」。播放器虽懒加载，仍占 UI 和一段内联脚本。

**涉及**

- `archetypes/default.md`
- `layouts/partials/article/components/music.html`（`with .Params.musicid`，空则不渲染，不用改逻辑）

**验收**

- `hugo new` 出来的 frontmatter 无 musicid，或为空。
- 已有文章不强制改；只有仍写了 musicid 的才显示播放器。
