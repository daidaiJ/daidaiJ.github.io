---
title: "lumberjack 日志库组件权限陷阱"
slug: "lumberjack"
description: ""
date: 2025-07-20T15:09:23+08:00
lastmod: 2025-07-20T15:09:23+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["bugfix"]
tags: ["golang","bugfix"]
image: https://picsum.photos/seed/f2c285b0/800/600
---
# lumberjack 日志库组件权限陷阱
------
> 之前一直使用go zero 的logx 组件来创建一个滚动日志，对filebeat 日志收集容器兼容性很好；近期在换成zero log+ lumberjack 的这套方案时用，和filebeat 的边车模式产生了冲突；
## 现象  
filebeat 服务告警，指向的日志文件权限不可访问；使用webssh 上去查看时发现`ls -al` 看到的权限是"0600"，也就是说不支持其他用户组的服务去访问，于是检查代码，发现并未手动创建日志，赋予0600文件权限，所以问题是lumberjack组件内部的默认文件权限是0600。  
那到底是哪部分导致的？ [源码](https://github.com/natefinch/lumberjack/blob/4cb27fcfbb0f35cb48c542c5ea80b7c1d18933d0/lumberjack.go#L215)  
通过翻看上述部分源码，确认是默认给的权限就是0600，搜索issue 发现[自定义文件权限](https://github.com/natefinch/lumberjack/issues/164)里面提到：
> Lumberjack will copy the permissions of the existing file when it creates the new file.
See here: https://github.com/natefinch/lumberjack/blob/v3/lumberjack.go#L267  
  So if you want different file permissions, the easiest thing to do is create the file with the permissions you want, first.  
另外附加源头pr 链接：https://github.com/natefinch/lumberjack/pull/112, 这里做出这个变更的原因据称是为了审计要求，收紧默认权限。十分甚至一百分的不优雅，加个Options 让使用者自己选不是比默认0600好很多？


所以处理策略就是在使用前，先创建一个644权限的日志文件，然后关闭,再将该文件名交给lumberjack 组件。这样lumberjack会复制原始文件的权限，创建新的日志文件，避免边车容器因为用户组不同导致600无法访问文件的事情；
## 处理
简单的加三行代码
```go
if fp, err := os.OpenFile(fileName, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0644); err == nil {
		fp.Close()
} 
```
## 总结
使用不熟悉的库遇到问题的时候，光翻找官方教程和在线博客可能是不够的，需要结合源码和issue 去排查。