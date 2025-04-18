---
title: "sse"
slug: "sse"
description: "一个gin 使用服务端推送的笔记"
date: 2025-04-18T12:33:29+08:00
lastmod: 2025-04-18T12:33:29+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 156736
categories: ["go","实用代码"]
tags: ["golang"]
image: https://picsum.photos/seed/51efc8ca/800/600
---

# sse gin 的花式推送

> 众所周知ai llm 这些东西让SSE 这个技术传遍"石河子"东西南北

其实按照推送技术来说还是有不少的：
- chunk 分块 这个其实是SSE 的基础
- sse 服务端推送事件
- websocket 这个可以支持双向的，但是无法兼容h2

## 代码示例
下面给一下处了 websocket 以外的 推送示例

```go
func ChunkDemo(c *gin.Context) {
		w := c.Writer
		header := w.Header()
		header.Set("Transfer-Encoding", "chunked")
		header.Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`
			<html>
					<body>
		`))
		w.(http.Flusher).Flush()
		for i := 0; i < 10; i++ {
			w.Write([]byte(fmt.Sprintf(`
				<h1>%d</h1>
			`, i)))
			w.(http.Flusher).Flush()
			time.Sleep(time.Duration(1) * time.Second)
		}
		w.Write([]byte(`
			
					</body>
			</html>
		`))
		w.(http.Flusher).Flush()
	})
// h1 sse
func sseHandlerHTTP1(c *gin.Context) {
    // 设置响应头
    c.Writer.Header().Set("Content-Type", "text/event-stream")
    c.Writer.Header().Set("Cache-Control", "no-cache")
    c.Writer.Header().Set("Connection", "keep-alive")
    c.Writer.Header().Set("Access-Control-Allow-Origin", "*")

    // 确保响应头被立即发送
    c.Writer.(http.Flusher).Flush()

    ticker := time.NewTicker(2 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-c.Request.Context().Done():
            return
        case t := <-ticker.C:
            // 发送SSE消息
            c.Writer.Write([]byte("data: " + t.Format(time.RFC3339) + "\n\n"))
            c.Writer.(http.Flusher).Flush()
        }
    }
}
func sseHandlerHTTP2(c *gin.Context) {
    // 设置响应头
    c.Writer.Header().Set("Content-Type", "text/event-stream")
    c.Writer.Header().Set("Access-Control-Allow-Origin", "*")

    // 确保响应头被立即发送
    c.Writer.(http.Flusher).Flush()

    ticker := time.NewTicker(2 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-c.Request.Context().Done():
            return
        case t := <-ticker.C:
            // 发送SSE消息
            c.Writer.Write([]byte("data: " + t.Format(time.RFC3339) + "\n\n"))
            c.Writer.(http.Flusher).Flush()
        }
    }
}
```
上面的区别其实是 h2 不用设置客户端缓存控制这个响应头, 比较统一的是推送开始和结束都需要Flush 刷写一下