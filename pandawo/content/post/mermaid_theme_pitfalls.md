---
title: "Mermaid 主题定制暗坑大全"
slug: mermaid-theme-pitfalls
description: ""
date: 2026-09-06T20:06:28+08:00
lastmod: 2026-09-06T20:06:28+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories:
    - ai
    - 笔记
tags:
    - mermaid
    - 主题
    - css
image: https://picsum.photos/seed/8115e44d/800/600
---
# Mermaid 主题定制暗坑大全
------
> 我给 mmdx（自己的 Mermaid 导出器）做了一套完整主题预设，过程中在 mermaid 的主题机制上反复撞墙：变量改了不生效、CSS 写了被盖、颜色改了换了个地方又冒出来。这篇把踩过的坑整理成 checklist，每条都是"现象 → 为什么 → 怎么绕"，代码全部来自真实仓库。

## 先立结论：themeVariables 根上的键永远生效
------
这是整个主题定制的第一原则，反过来用就是最重要的排错手段。

mermaid 的主题计算（`Theme.calculate`）流程是三步：用户覆盖 → 推导派生色 → 再覆盖。也就是说 `themeVariables` **根上**的键永远赢——不管后面的推导链怎么算，你写在根上的值是最后生效的。所以：

- 变量"不生效"，九成不是机制问题，而是**嵌套位置错**——键被插到了某个图型的子配置里，而不是 `themeVariables` 根上。
- 例外只有一种：渲染器根本不读这个变量（走了硬编码），那是另一类坑，后面单说。

我真实踩过的版本：用 python 脚本给主题补丁批量插入 `pie1`~`pie12`、`quadrant1Fill`、`todayLineColor` 十几个键，锚点缩进算错一层，整批键被插进了 `themeVariables.xyChart` 对象**内部**：

```js
themeVariables: {
  primaryColor: '#E8F3FF',
  // ...几十个根级键...
  xyChart: {
    plotColorPalette: '#5B8FF9,#F6BD16,...',
    pie1: '#5B8FF9',      // ← 全在这里，静默失效
    pie2: '#5AD8A6',      //   pie 图根本不读 xyChart 命名空间
    todayLineColor: '#FF9A2E',
  },
},
```

配置是合法 JSON，渲染不报错，颜色就是不变。排错半天以为是变量名写错或 mermaid 版本问题，最后把配置 dump 出来做括号深度计数才发现层级错了。

> "变量不生效 = 先查嵌套位置"，这条现在是我排 mermaid 主题问题的第一反应。批量改配置结构后，写个脚本断言每个键的括号深度，或者干脆整段重写而不是锚点替换——锚点替换省的那几分钟会在排错时十倍还回来。

## assignWithDepth：数组是追加不是替换
------
第二个大坑在 mermaid 合并用户配置的入口函数 `assignWithDepth` 里。看 mermaid 源码（`src/assignWithDepth.ts`，dist 产物 `chunk-DU6HZSFF.mjs` 原样保留）：

```js
var assignWithDepth = (dst, src, { depth = 2 } = {}) => {
  if (Array.isArray(src) && !Array.isArray(dst)) {
    src.forEach((s) => assignWithDepth(dst, s, config2));
    return dst;
  } else if (Array.isArray(src) && Array.isArray(dst)) {
    src.forEach((s) => {
      if (!dst.includes(s)) {   // ← 追加，不是替换
        dst.push(s);
      }
    });
    return dst;
  }
  // 对象走递归合并，标量直接覆盖 —— 这部分行为正常
```

对象合并符合直觉，标量覆盖也正常，唯独**数组是 push**。dst 里已经有默认值时，你配置的数组元素会追加在默认值后面。

具体受害场景是 journey 图的 actor 圆点。journey 配置里有 `actorColours` 数组，我配置成：

```js
journey: {
  actorColours: ['#6E94BB', '#7FB08A', '#63A8A4', '#D2A36C', '#8B99A8', '#C48BA6'],
},
```

结果圆点颜色纹丝不动。原因是 mermaid 默认的 6 个 actor 颜色已经占了 `0-5` 槽位，我的 6 个颜色被 append 到第 7-12 位——而 journey 只有 6 个 actor，永远读不到追加的段。同理 `journey.actorColours` 在 `themeVariables.cScaleInv` 那条路上也有类似问题。

怎么绕？journey 圆点的 fill 是 SVG presentation attribute（`fill="cornsilk"` 这类），而 presentation attribute 的优先级低于**任何** CSS 规则。所以用 themeCSS 直接压：

```css
/* src/themes.ts — journey actor dots: config.journey.actorColours is useless —
   mermaid's assignWithDepth APPENDS arrays, so the hardcoded defaults keep
   slots 0-5. Presentation-attribute fills lose to plain CSS, so pin the dots here. */
.actor-0 { fill: #6E94BB; stroke: #FFFFFF; }
.actor-1 { fill: #7FB08A; stroke: #FFFFFF; }
/* ... .actor-2 到 .actor-5 同理 */
```

> "presentation attribute 输给任何 CSS"是 SVG 规范行为，不是 mermaid 的锅，但它决定了绕法的方向：凡是 fill 写死在元素属性上的地方，别试图找主题变量了，直接 CSS 压，稳赢。

## themeCSS 的 #svgId 前缀：svg 根类匹配不到
------
第三个坑在 themeCSS 本身。mermaid 拿到 `themeCSS` 后不是原样注入 `<style>`，而是给**每条规则**加一个 `#svgId` 前缀（svg 元素的 id 选择器），把作用域限定在当前图里。

这意味着你的选择器实际生效形式是：

```css
/* 你写的 */
.erDiagram .entityBox { fill: #E8F3FF; }

/* 实际注入的 */
#svgId .erDiagram .entityBox { fill: #E8F3FF; }
```

问题来了：`.erDiagram` 这个类挂在 **svg 根元素**上，而 `#svgId` 就是这个根元素。CSS 里"X 的后代 Y"要求 X 是 Y 的祖先——svg 根不可能是自己的后代，所以 `#svgId .erDiagram ...` 永远匹配不到任何元素。凡是想以 svg 根类做后代选择器中间环节的写法，全部静默失效。

绕法：跳过根类，直接锚定根类**内部**的结构类：

```css
/* src/themes.ts — ER 实体外壳是 .node path，属性行走 themeVariables */
.node .outer-path path { fill: #E8F3FF; stroke: #4098FC; }
.node .row-rect-odd path { fill: #FFFFFF; stroke: #4098FC; }
.node .row-rect-even path { fill: #F7F8FA; stroke: #4098FC; }
/* class 图的分隔线也会撞上 .node path 规则，单独钉住 */
.divider path { stroke: #4098FC; }
```

注意上面还有个连锁坑：ER 实体外壳和 class 图的分隔线都是 `.node path`，会被 flowchart 的通用 `.node path` 填色规则误伤（我把通用 path 涂成紫色代表"存储"，结果 ER 实体全紫了）。主题 CSS 里每加一条宽泛规则，都要想一遍哪些图型的哪些元素也满足这个选择器。

> 官方文档完全没提 #svgId 前缀这回事，themeCSS 的行为只能靠 dump 生成的 SVG `<style>` 反推。我怀疑没几个人成功用过 `.erDiagram` 开头的 themeCSS 选择器。

## 内联 style !important：CSS 的尽头是改数据
------
第四个坑是优先级天花板。C4 图的元素标签文字是**硬编码白色内联样式**——渲染器里直接 `color: fontColor ?? '#FFFFFF'` 且带 `!important` 写进元素的 `style` 属性。内联样式加 `!important`，是 CSS 层叠里赢不了的东西：任何外部样式表规则，不管特异性多高，都输给它。

所以我给 C4 换浅色主题的第一次尝试：`themeCSS` 里写 `text { fill: #1D2129 !important }` 之类，全部无效。

绕法只有一条：**改数据源头**。不动文字颜色，把 C4 的填充色调到足够深，让白字可读。官方通道是 `config.c4` 段（这也是 C4 填充色的正确出处，不在 themeVariables 里）：

```js
// src/themes.ts — C4 element palette: official channel is the c4 config section
// NOTE: c4 label text is hardcoded white inline (c4ShapeAdapter: color:
// fontColor ?? '#FFFFFF', applied with !important) — no theme variable
// can change it, so fills must stay dark enough for white text
c4: {
  person_bg_color: '#4A6F94', person_border_color: '#3A5A78',
  external_person_bg_color: '#76828F', external_person_border_color: '#6A7581',
  container_bg_color: '#4A6F94', container_border_color: '#3A5A78',
  // ...
},
```

> 这条给了我一个方法论上的提醒：遇到"怎么写 CSS 都不生效"时，先确认目标元素上有没有内联 `!important`（dump SVG 看 `style` 属性）。有，就别在 CSS 层纠缠了，往上找数据源——改不了数据源（比如白字是 mermaid 写死的），就把自己的设计往数据源头让步，而不是继续堆选择器。

## 直接命中 beats 继承：压到实际文字元素上
------
第五个坑是层叠里最不起眼的一类。我想统一图内文字颜色，在容器层设置：

```css
.mindmap-node .label { color: #1D2129 !important; }
```

`.label` 是 foreignObject 里的 div，直觉上 color 会继承到内部所有文字。但 mindmap 某些节点的文字元素（`span`、`.text-inner-tspan`）上挂着**直接命中**的规则（比如 root 节点的 tspan 通过 section-root 规则拿到 `gitBranchLabel0` 的白色），直接命中永远赢过继承——父元素的 color 设得再对，子元素自己有规则就轮不到继承。

绕法：选择器覆盖到**实际渲染文字的元素**，一层都别省：

```css
/* src/themes.ts — mindmap 标签是 HTML（foreignObject）——
   颜色必须钉到 span/p/tspan 级别，root 的 text-inner-tspan 否则会
   经 section-root 规则拿到 gitBranchLabel0（白色） */
.mindmap-node .label,
.mindmap-node .label div,
.mindmap-node .label span,
.mindmap-node .label p,
.mindmap-node .text-inner-tspan { color: #1D2129 !important; fill: #1D2129 !important; }
```

这里 `fill` 也要一起设——SVG 文字的着色走 `fill` 而不是 `color`，混排（HTML 标签 + SVG tspan）的图两种都要覆盖。

> 层叠顺序"直接命中 beats 继承"是 CSS 基本功，但在 mermaid 里特别容易栽：图型渲染器往内部元素上撒直接规则的习惯比一般网页重得多。div 上设 color "看起来生效了一部分"（普通节点对了，root 节点没对）比全不生效更迷惑人。

## 同特异性看插入顺序：neo 主题的渐变遮蔽
------
前面几条都是"我的规则被别人盖"，这一条反过来：mermaid 自己生成的规则会盖掉 themeVariables。

开 `look: 'neo'` 后（切换到 theme-neo 那套渲染），mermaid 会为 mindmap 每个分区生成带渐变填充的规则，并**追加在 themeCSS 之后**注入。同特异性时后者赢，结果就是我在 `themeVariables.cScale0-5` 里精心配的分区色全部被 `mainBkg + gradient stroke` 的统一渐变盖掉，mindmap 各分支变成同一种颜色。

绕法是在 themeCSS 里显式恢复，并用 `!important` 对抗插入顺序（规则来源无法控制顺序时，特异性又相同，只能加权重）：

```css
/* src/themes.ts — under look:'neo' the generated gradient rule (appended
   later, same specificity) paints EVERY section box mainBkg + gradient
   stroke, masking the cScale section colours; restore per-branch pastels */
.mindmap-node.section--1 rect,
.mindmap-node.section--1 path,
.mindmap-node.section--1 circle { fill: #E8F3FF !important; stroke: #4098FC !important; stroke-width: 2.5px !important; }
.mindmap-node.section-0 rect, /* ...0-5 各分区同理... */
```

注意根节点是 `section--1`（双横线），分区是 `section-0` 到 `section-N`——这个命名也是 dump SVG 才能确认的。

> mermaid 的规则注入顺序是"基础 themeCSS → 图型生成规则 → neo 渐变"，我方永远在下游被动挨打。能用 themeVariables 根键解决的绝不用 CSS，因为 CSS 要跟生成规则抢位置；根键走的是 Theme.calculate 的覆盖链，不受注入顺序影响。

## 验证方法论：dump + 反查，不靠记忆猜
------
以上每个坑的定位过程都指向同一套验证手段，值得单独总结。主题排错**不要对着记忆猜优先级**，两步拿到事实：

1. **dump SVG 的 `<style>` 全部规则**：把渲染产物 SVG 存下来，看 `<style>` 里到底注入了什么、顺序如何、有没有 `#svgId` 前缀、目标元素上挂着哪些规则。内联样式直接看元素的 `style` 属性。
2. **getComputedStyle 反查**：在浏览器 console 里对目标元素跑 `getComputedStyle(el)`，看 `fill`/`color` 的最终值，再沿匹配规则定位来源。

在 mmdx 里我把这个思路固化成了全覆盖检测脚本（`scripts/theme-census.ts`）：渲染全部图型，像素级统计颜色，凡是落在主题调色板和合成容差之外的都报警，外加一张"mermaid 原生刺眼默认色"黑名单按任意覆盖率标记（小元素如 journey 圆点面积太小，覆盖率阈值会漏报，只能靠黑名单兜）：

```ts
// scripts/theme-census.ts — allowed palette = themes.ts 里每个 hex 字面量 + 黑白
for (const m of themeSrc.matchAll(/#([0-9a-fA-F]{6})\b/g)) allowed.add('#' + m[1].toUpperCase());
// ...渲染后逐像素计数，接受"调色板色以某 alpha 合成到白底"的结果（抗锯齿/半透明填充）
```

关键设计：黑名单必须有**定义来源**（主题调色板全集），只列已知坏值（比如 `#ECECFF` 这个 mermaid 紫）会漏掉"自家主题色被误用"这类新形态——这也是我从教训里烧出来的：第一版检测脚本只黑名单了 `#ECECFF`，结果自己的 Arco 色被另一条规则覆盖了照样漏。

> 手工排错靠 dump + 反查，批量验收靠像素普查。两者缺一不可：前者定位单点，后者保证"改 A 没顺手弄坏 B"——主题这种全联动的东西，没有全覆盖检测就是在打地鼠。

## 颜色散落地图
------
最后一个 checklist 是"哪里能改哪个颜色"。mermaid 的颜色配置入口散落在至少四个地方，找对入口能省掉前五节大半的斗争：

| 图型/元素 | 颜色入口 | 备注 |
|---|---|---|
| 全局派生链 | `themeVariables` 根（primaryColor 等） | 根键永远生效，配这里优先 |
| C4 元素填充 | `config.c4.*` | 不在 themeVariables；白字硬编码，填充必须够深 |
| journey 分段 | `themeVariables.fillType0-7` | 圆点例外，见 assignWithDepth 一节 |
| xyChart 调色板 | `themeVariables.xyChart.plotColorPalette` | 逗号分隔字符串，不是数组；默认头一个就是 `#ECECFF` 紫 |
| radar 曲线 | `themeVariables.cScale` + `config.radar` | cScale 粉彩在刻度网上不可读，我用 CSS 覆盖成 AntV 色 |
| mindmap 根节点 | `themeVariables.git0` / `gitBranchLabel0` | 是的，mindmap 借用 gitgraph 的变量名 |
| treemap | `cScale`（类目）+ `cScalePeer` | 相邻分区色差太小，CSS 单独配 |
| sankey | 无主题变量 | 走 tableau10 硬编码，mmdx 里用渲染后 hex→hex remap 补救 |
| neo look 渐变 | `themeVariables.gradientStart/Stop` | 注意 genGradient 遮蔽 mindmap 分区色 |

`look: 'neo'` 这个开关单独提醒：它不只是加圆角，是整套渲染走 theme-neo 的新代码路径，渐变生成、阴影、mindmap 分区行为都变了。我最后是 neo + 显式 CSS 恢复分区色的组合。

> sankey 那行值得多说一句：连主题变量都没有的图型，唯一出路是渲染后处理。mmdx 的 `ThemePreset.remap` 就是为此存在的——PNG 出来前对 SVG 里的硬编码 hex 做一次映射表替换。丑，但比魔改 mermaid 源码可持续。

## 最后是工程坑：批量补丁怎么不翻车
------
上面的坑里有两类（补 themeVariables 大批键、补 themeCSS 大段规则）都涉及"往配置文件里批量插入大块内容"，这里踩的坑不在 mermaid 而在工具链：

**坑一：超长 heredoc 截断。** 用 bash heredoc 往文件里写整段 CSS/配置模板，内容一长（几百行）会被静默截断，文件尾部缺失。绕法：大块内容用 Write 工具（或编辑器）写成独立文件，再用小脚本拼接进去，heredoc 只留给几行的东西。

**坑二：python 补丁必须带断言和回滚。** 批量插入用锚点替换时，锚点选错（缩进差一层）就是我第一节那个 pie1-12 插错层的事故。防线两条：

```python
# 每个 replace 前断言锚点恰好出现一次
assert src.count(anchor) == 1, f"anchor not unique: {anchor[:40]}"
src = src.replace(anchor, patched)
# 任何一步失败，整体回滚，不许半成品落盘
```

插入后立刻做**层级断言**：括号深度计数，断言新键在预期嵌套层级上。锚点替换赌的是"锚点文本唯一且位置如我所想"，断言是把这个赌注变成显式检查。

> 这两条是纯工程纪律，但和 mermaid 的坑叠加起来杀伤力最大：插错层是静默失效，heredoc 截断也是静默截断——两个静默叠在一起，你还以为自己的主题配置"试过了没用"。所有静默失败的工具链环节，都值得配一道显式断言。

------
> 总结成一句话：mermaid 主题定制的所有坑，本质是"三层优先级体系 + 散落的配置入口"——themeVariables 根键 > CSS（受 #svgId 前缀、注入顺序、内联 !important 制约）> presentation attribute，而 C4 白字、sankey 配色这类硬编码点只能改数据或后处理。排错永远从 dump SVG 开始，不要猜。下一篇写 mmdx 本身的设计，以及那套全覆盖像素检测是怎么建的。
