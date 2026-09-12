---
id: T09
issue: I04
cost: low
status: done
---

# archetype 去掉空 description 陷阱

**改**

- `archetypes/default.md`：删 `description: ""`，或改成占位注释说明必填一句摘要。
- 不改已有文章（见 T10）。

**验收**

- `hugo new content/post/foo.md` 不再带空 description。
