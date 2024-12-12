---
title: "使用wails 构建桌面程序实操"
slug: "wails-build"
description: "使用wails 的经验"
date: 2024-12-12T11:47:28+08:00
lastmod: 2024-12-12T11:47:28+08:00
draft: false
toc: true
weight: false
musicid: 5264842
categories: ["gui","实践经验"]
tags: ["golang"]
image: https://picsum.photos/seed/2e89fdd0/800/600
---

# Wails 构建桌面程序实操
***********
> Wails 是一个用于构建桌面应用程序的 Go 框架。官网如下 [wails](https://wails.io/)

## 简单前端项目封装
首先在 go install github.com/wailsapp/wails/v2/cmd/wails@latest 安装完wails 后用 wails doctor 来检查下依赖环境
1. 用 wails init -n name -t  -t vanilla[-ts]    
   -  带-ts 会从js 切换到ts
   -  可以将 t 参数后面的模板换成其他 例如 vue react svelte
2. 将前端项目迁移到frontend 目录下
3. 将项目根目录下的wails.json 和 frontend 目录下的package.json 里面的构建命令对应起来
4. 将builid/appicon.png 替换成你想要的图标图片，最好是无背景1024*1024 大小的
5. 下载upx 放到 path 变量所在的路径
6. wails build  -upx -upxflags  --lzma -platform windows/amd64   
   - 构建过程中 加 -nsis 会生成安装程序（需要另外安装），
   - 加-devtools 可以在软件右键开发者模式查看
   - 加-webview2 指定webview 依赖处理方式
     - Download（下载）
     - Embed（内嵌）
     - Browser（浏览器）
     - Error（报错）
7. wails json 里面 有个 info 可以给执行文件的信息里面添加你的版权信息，而且不可以被别人修改
```json
"Info": {
    "companyName": "My Company Name",
    "productName": "Wails Vite",
    "productVersion": "1.0.0",
    "copyright": "Copyright©2024TigerJuice",
    "comments": "Built using Wails (https://wails.io)"
  },
```
**顺便推广下我用wails 封装的PokeRogue 桌面程序  [PokeRogueWinDesk](https://github.com/daidaiJ/PokeRogueWinDesk)**
## 涉及到后端的一些数据交互
1. 用本地网络套接字去传输，纯web 这套逻辑
2. 使用wails 的go 函数bind，可以通过运行时js 库导入到js 当中 
3. 使用wails 提供的运行时管道，应用起来，示例如下
```go
    func (a *App) syncWriter(str string) {
	var tmp string
	if strings.HasSuffix(str, "\n") {
		tmp = fmt.Sprintf("%s: %s", time.Now().Local().Format(time.RFC3339), str)
	} else {

		tmp = fmt.Sprintf("%s: %s\n", time.Now().Local().Format(time.RFC3339), str)
	}
	fmt.Fprintf(a.fw, tmp)
	runtime.EventsEmit(a.ctx, "sse", tmp)
}
```
上面这个是一个函数用来将日志消息通过管道同步到前端，前端订阅如下，
```js
 EventsOn("sse", (data) => {
        printlog(data);
    });
```
其实整套逻辑就是pub sub 的一种实现，这个反过来前端js 去推送，后端去订阅也是一样的
## 项目组织结构
-project
--/build
--/frontend
--/pkg 
--/wailsjs
--app.go
--main.go
--wails.json

可以通过增加 /pkg 目录来管理go 的后端逻辑，要是已经有一个后端的代码包，也可以提升到和project 同级目录下，然后通过 go mod 里面用 `replace pkg v0.0.0=> ../pkg` 来关联
