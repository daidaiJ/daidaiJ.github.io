---
id: T02
issue: I01
cost: low
status: done
---

# 列表封面按展示尺寸拉图

卡片高约 150–305px，仍请求 800×600。依赖 T01 之后再做，避免和 loading 改动打架。

**改**

- `layouts/partials/helper/cover-remote.html`：接受 `w`/`h`（默认 800/600），picsum 与 wsrv/weserv 参数跟尺寸走。
- 列表调用 cover-img / cover-remote 时传约 `480×360`（或 `640×480`），文章页仍 800×600。
- Met / Unsplash 原图若无法改尺寸，至少让 wsrv 备份按小尺寸拉。

**验收**

- 首页封面 URL 宽度 ≤ 640（或 wsrv `w=` 对应）。
- 文章页头图仍接近 800 宽。
- 失败降级链不断。
