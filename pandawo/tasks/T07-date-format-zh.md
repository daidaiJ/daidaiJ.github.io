---
id: T07
issue: I03
cost: low
status: done
---

# 日期格式改中文习惯

**改**

- `hugo.yaml`：
  - `dateFormat.published`: `Jan 02, 2006` → `2006-01-02` 或 `2006 年 1 月 2 日`
  - `dateFormat.lastUpdated`: 同步，可保留时间。

**验收**

- 文章列表与页脚日期为中文/ISO，不再出现 `Sep 12, 2026`。
