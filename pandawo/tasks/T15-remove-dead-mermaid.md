---
id: T15
issue: I10
cost: low
status: done
---

# 删除未引用的 extend-footer

主题 `footer/include.html` 只 include `footer/custom.html`。`extend-footer.html` 里另有一份 Mermaid（theme `default`），`custom.html` 才是实际生效的（`neutral`）。

**改**

- 删 `layouts/partials/footer/extend-footer.html`。
- 不改 `custom.html`，除非确认两边逻辑要合并。

**验收**

- 含 mermaid 的文章仍出图、跟配色切换。
- 仓库里只剩一份 mermaid 注入。
