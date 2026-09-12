---
id: T16
issue: I10
cost: low
status: done
---

# 拆开重复封面 seed

`opensandbox_pool_churn.md` 与 `ctx_lean_1_pipeline.md` 的 image seed 都是 `a1d6f19c`，打散后仍会同图。

**改**

- 给其中一篇换新 seed（8 位 hex），保持 `https://picsum.photos/seed/{hex}/800/600`。
- 不要热链 Fastly HMAC URL。

**验收**

- 两篇 `image:` 的 seed 不同。
- 首页若同时出现，主源图不一样。
