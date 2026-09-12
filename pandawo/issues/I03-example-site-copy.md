---
id: I03
priority: 3
benefit: medium-high
cost: low
status: closed
tasks: [T04, T05, T06, T07]
---

# exampleSite 与英文文案残留

中文站仍混着主题示例和英文 UI：

- `content/page/about/index.md` 是 Hugo 英文介绍，aliases 含 `about-hugo`。
- 归档 title `Archives`，搜索 title `Search`。
- 根 `params.sidebar.subtitle` 仍是 Lorem ipsum（语言块里才是中文）。
- 日期格式 `Jan 02, 2006`。

**涉及**

- `content/page/about/index.md`
- `content/page/about/index.zh-cn.md`
- `content/page/archives/index.md`
- `content/page/search/index.md`
- `hugo.yaml`（sidebar.subtitle、dateFormat）

**验收**

- `/about/` 只有中文关于页，无 Hugo 示例文案。
- 菜单与页面标题为中文。
- 侧栏副标题、JSON-LD 站点描述不再出现 Lorem ipsum。
- 文章日期按中文习惯显示。
