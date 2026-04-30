# Hugo 博客优化设计文档

## 概述

对 PandaWo Hugo 博客进行三项优化：
1. 清理本地构建残留产物
2. 实现左右侧边栏可折叠功能
3. 优化 GitHub Actions Workflow 提升网页加载性能

---

## 第一部分：清理构建产物

### 应删除的文件/目录

| 路径 | 说明 |
|------|------|
| `pandawo/public/` | Hugo 构建输出目录，包含所有生成的静态 HTML/CSS/JS |
| `pandawo/resources/_gen/` | Hugo 资源处理缓存（图片处理等） |
| `pandawo/.hugo_build.lock` | Hugo 构建锁文件 |

### 更新 `.gitignore`

```gitignore
# Hugo 构建产物
pandawo/public/
pandawo/resources/
pandawo/.hugo_build.lock

# 设计文档（本地开发用）
docs/

# 系统文件
*.exe
.DS_Store
Thumbs.db

# IDE
.idea/
.vscode/
*.swp
```

---

## 第二部分：侧边栏折叠功能

### 功能规格

- **左侧栏**：可折叠，包含头像、站点名称、菜单
- **右侧栏**：可折叠，包含搜索、归档、分类、标签云 widgets
- **交互方式**：点击按钮切换显示/隐藏
- **状态持久化**：保存到 localStorage，页面刷新后恢复
- **视觉效果**：平滑过渡动画（300ms），折叠时主内容区自动扩展

### 文件结构

使用 Hugo 主题覆盖机制，不修改主题源码：

```
pandawo/
├── layouts/
│   └── partials/
│       ├── sidebar/
│       │   ├── left.html      # 覆盖主题左侧栏
│       │   └── right.html     # 覆盖主题右侧栏
│       ├── head/
│       │   └── extend-head.html  # 折叠按钮 CSS
│       └── footer/
│           └── extend-footer.html  # 折叠脚本 JS
└── assets/
    └── js/
        └── sidebar-toggle.js   # 折叠功能脚本
```

### 折叠按钮设计

**左侧栏按钮**：
- 位置：侧边栏顶部右侧
- 图标：使用 Tabler Icons 的 `layout-sidebar-left-collapse` / `layout-sidebar-left-expand`
- 样式：圆形、半透明背景、悬停高亮

**右侧栏按钮**：
- 位置：侧边栏顶部左侧
- 图标：使用 Tabler Icons 的 `layout-sidebar-right-collapse` / `layout-sidebar-right-expand`
- 样式：同上

### CSS 样式

```scss
// 折叠状态
.sidebar.collapsed {
  width: 0 !important;
  min-width: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
  overflow: hidden;
  opacity: 0;
  
  * {
    visibility: hidden;
  }
}

// 折叠按钮
.sidebar-toggle-btn {
  position: absolute;
  top: 10px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--card-background);
  box-shadow: var(--shadow-l1);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  z-index: 100;
  
  &:hover {
    background: var(--accent-color);
    color: white;
  }
  
  svg {
    width: 18px;
    height: 18px;
  }
}

// 左侧栏按钮位置
.left-sidebar .sidebar-toggle-btn {
  right: -16px;
}

// 右侧栏按钮位置
.right-sidebar .sidebar-toggle-btn {
  left: -16px;
}

// 过渡动画
.sidebar {
  transition: width 0.3s ease, opacity 0.3s ease, padding 0.3s ease;
}
```

### JavaScript 功能

```javascript
// 核心功能
const SidebarToggle = {
  STORAGE_KEY: 'sidebar-state',
  
  init() {
    // 初始化：读取 localStorage，恢复状态
    // 绑定按钮点击事件
  },
  
  toggle(sidebar) {
    // 切换侧边栏状态
    // 更新按钮图标
    // 保存状态到 localStorage
  },
  
  loadState() {
    // 从 localStorage 读取状态
  },
  
  saveState(state) {
    // 保存状态到 localStorage
  }
};

document.addEventListener('DOMContentLoaded', () => SidebarToggle.init());
```

---

## 第三部分：Workflow 优化

### 当前 Workflow 分析

**现有流程**：
1. Checkout 代码
2. 安装 Hugo
3. 构建站点
4. 部署到 GitHub Pages

**问题**：
- 无缓存，每次都重新下载 Hugo 模块
- 无压缩，静态资源体积大
- 无性能优化步骤

### 优化后 Workflow

```yaml
name: GitHub Pages

on:
  push:
    branches: [main]
  pull_request:

jobs:
  deploy:
    runs-on: ubuntu-22.04
    concurrency:
      group: ${{ github.workflow }}-${{ github.ref }}
    
    steps:
      - uses: actions/checkout@v4
      
      # 缓存 Hugo 模块
      - name: Cache Hugo modules
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/hugo_cache
            ~/go/pkg/mod
          key: ${{ runner.os }}-hugo-modules-${{ hashFiles('**/go.sum') }}
          restore-keys: |
            ${{ runner.os }}-hugo-modules-
      
      - name: Setup Hugo
        uses: peaceiris/actions-hugo@v3
        with:
          hugo-version: '0.139.3'
          extended: true
      
      - name: Build
        working-directory: ./pandawo
        run: hugo --baseURL https://daidaij.github.io/ --minify
      
      # 图片优化（可选，仅在有时间时启用）
      - name: Optimize Images
        run: |
          sudo apt-get install -y optipng jpegoptim
          find ./pandawo/public -name "*.png" -exec optipng -o5 {} \; 2>/dev/null || true
          find ./pandawo/public -name "*.jpg" -exec jpegoptim --max=85 {} \; 2>/dev/null || true
      
      # 生成预压缩文件
      - name: Pre-compress files
        run: |
          find ./pandawo/public -type f \( -name "*.html" -o -name "*.css" -o -name "*.js" -o -name "*.xml" -o -name "*.json" \) -exec gzip -k -9 {} \;
          find ./pandawo/public -type f \( -name "*.html" -o -name "*.css" -o -name "*.js" -o -name "*.xml" -o -name "*.json" \) -exec brotli -k -9 {} \;
      
      - name: Deploy
        uses: peaceiris/actions-gh-pages@v3
        if: github.ref == 'refs/heads/main'
        with:
          PERSONAL_TOKEN: ${{ secrets.ACTION_TOKEN }}
          PUBLISH_DIR: ./pandawo/public
          EXTERNAL_REPOSITORY: daidaiJ/daidaiJ.github.io
```

### 预期性能提升

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 构建时间 | ~2min | ~1min | 缓存减少 50% |
| HTML 体积 | 100% | ~30% | gzip 压缩 70% |
| CSS/JS 体积 | 100% | ~25% | gzip 压缩 75% |
| 图片体积 | 100% | ~70% | 无损压缩 30% |

---

## 实现任务清单

1. **清理构建产物**
   - [ ] 更新 `.gitignore`
   - [ ] 删除 `pandawo/public/` 目录
   - [ ] 删除 `pandawo/resources/_gen/` 目录
   - [ ] 删除 `pandawo/.hugo_build.lock`

2. **侧边栏折叠功能**
   - [ ] 创建 `pandawo/layouts/partials/sidebar/left.html`
   - [ ] 创建 `pandawo/layouts/partials/sidebar/right.html`
   - [ ] 创建 `pandawo/layouts/partials/head/extend-head.html`
   - [ ] 创建 `pandawo/layouts/partials/footer/extend-footer.html`
   - [ ] 创建 `pandawo/assets/js/sidebar-toggle.js`
   - [ ] 添加折叠按钮 CSS 样式

3. **Workflow 优化**
   - [ ] 添加 Hugo 模块缓存
   - [ ] 添加图片优化步骤
   - [ ] 添加预压缩步骤（gzip + brotli）

---

## 风险与回滚

- **主题更新**：使用 Hugo 覆盖机制，主题更新不影响自定义代码
- **折叠功能异常**：可通过删除 `layouts/partials/` 覆盖文件回滚
- **Workflow 失败**：可在 GitHub Actions 查看日志，禁用新增步骤