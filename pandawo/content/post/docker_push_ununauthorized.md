---
title: "Docker push ununauthorized"
slug: ""
description: ""
date: 2026-01-14T13:29:25+08:00
lastmod: 2026-01-14T13:29:25+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 3330241865
qqmusic: 
categories: ["问题排查"]
tags: ["harbor"]
image: https://picsum.photos/seed/fd3bdfd0/800/600
---

# 记录一次harbor 镜像报错失败的定位流程
> 问题背景，在通过docker client 库向harbor 仓库推送一个28G 左右的镜像时，会遇到推送到100% 左右出现`unauthorized: unauthorized to access repository: project_name/repo_name `的报错，导致整个job 失败，然后出现重试，导致业务层面看到push 进度从100%--> 0% 的奇怪现象

## 搜索与llm
1. llm 提示要检查nginx 转发配置和认证的token 配置的有效时间；
2. 搜索到的绝大多数解决方法都是 login 一下

这两者中1 比较符合项目上出现的情况，因为是有成功过的推送过程的，近似于超时，2 离得比较远了，而且确认过鉴权正常；
## 翻找harbor issue
> Can't push large image if the process takes more then 30 min - unauthorized to access repository  
[harbor push 30min超时，出现unauthorized: unauthorized to access repository](https://github.com/goharbor/harbor/issues/19413)  这是原issue 连接 ，有相应的解决方法

![harbor 会话有效时间](asset/harbor_session_expire.png)
这里对应我们业务的影响其实是会话有效时间，貌似harbor 需要在一个鉴权后的会话中完成镜像的推送流程

## 结论
在harbor web 管理页中修改了系统配置的会话有效时间解决了这个问题