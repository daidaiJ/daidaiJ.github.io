---
id: T14
issue: I09
cost: low
status: cancelled
---

# 新文默认不挂 musicid（已关闭：by design）

> **2026-09-12 决定**：音乐贴片是站点特色，新文保留默认 `musicid: 5264842`，本任务不做。

**改**

- `archetypes/default.md`：删除 `musicid: 5264842`，或留空。
- 已有文章不批量删；`music.html` 已是 `with .Params.musicid`。

**验收**

- 新文无播放器按钮。
- 仍写了 musicid 的旧文播放器还在。
