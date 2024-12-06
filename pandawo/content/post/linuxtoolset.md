---
title: "Linux 工具集合"
slug: ""
description: "个人自用"
date: 2024-12-06T15:32:49+08:00
lastmod: 2024-12-06T15:32:49+08:00
draft: false
toc: true
weight: false
musicid: 5264842
categories: ["工具"]
tags: ["linux"]
image: https://picsum.photos/seed/9fc93c63/800/600
---
# Linux 工具集合
## cli类
- bat  替代cat
- yazi 文件浏览器
- lsd 替代ls
- fastfetch
- SCC 代码统计
- starship shell prompt
- lnav 日志查看器
- ripgrep  反向搜索
## 软件类
- kitty 高性能终端模拟器
- hugo 静态博客生成器
- obsidian markdown 编辑器
- Tiling Assiant gnome 平铺管理器
- vscode
- 火焰截图
- 雾凇拼音
- copyQ
## 语言类
- uv 替代pip 和 conda 高效
- ruff  python lint
- protoc protobuf 编译器
- meson 轻量级编译构建工具
- ninja 构建工具
- docker 和 docker-compose 以及 dpanel
## alias
```bash
alias hgrep="history | grep "
alias cat="bat"
alias gm="git commit -m"
alias ls="lsd -a"
alias ll="lsd -al"
alias sudo="sudo"
alias reposhow='git remote show'
alias repoadd='git remote add'
alias fy="trans :en"
alias ff="fastfetch"
```

## Kitty
```shell
   include ./theme.conf
   font_family  Hack Nerd Font Mono
   font_size 14.0
   window_padding_width 10
   tab_bar_min_tabs 1
   tab_bar_edge bottom
   tab_bar_style powerline
   tab_powerline_style slanted
   tab_title_template {title}{' :{}:'.format(num_windows) if num_windows > 1 else ''}
```
