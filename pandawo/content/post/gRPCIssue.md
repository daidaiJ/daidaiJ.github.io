---
title: "GRPCIssue"
slug: ""
description: ""
date: 2025-03-10T15:42:14+08:00
lastmod: 2025-03-10T15:42:14+08:00
draft: false
toc: true
weight: false
musicid: 109532
categories: ["实践"]
tags: ["golang","gRPC"]
image: https://picsum.photos/seed/26afe642/800/600
---

# 近期gRPC使用中遇到的一些问题

## kitex 框架
> 字节开源的kitex RPC 框架是一个go 开发中比较常用的RPC 工具，通过 proto 生成对应的go 数据结构和 服务端代码

**问题**： gRPCCurl 和 BloomRPC 的两种调试工具用的短链接Unary 形式
