---
id: T04
issue: I03
cost: low
status: done
---

# 删除英文 about 示例页

`content/page/about/index.md` 是 Hugo 英文介绍，aliases 含 `about-hugo`。真实关于页是 `index.zh-cn.md`。

**改**

- 删 `content/page/about/index.md`。
- 把 `index.zh-cn.md` 改成 `index.md`（单语言站不必再 `.zh-cn`），或确认删英文后 `/about/` 仍渲染中文页。
- 检查是否还有 `about-hugo` 外链依赖（站内应无）。

**验收**

- `/about/` 是中文关于页，无 “about Hugo” 示例。
- 菜单关于项仍可用。
