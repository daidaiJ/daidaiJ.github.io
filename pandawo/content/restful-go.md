---
title: "简单的restful http client 包实现 "
slug: "go"
description: "a simple restful go http client package which is easy to use "
date: 2025-04-03T18:13:44+08:00
lastmod: 2025-04-03T18:13:44+08:00
draft: false
toc: true
weight: false
musicid: 109539
categories: ["go","实用代码"]
tags: ["golang"]
image: https://picsum.photos/seed/c73dd60a/800/600
---

# 一个restful http client 实现
------
> 主要是基于日常开发中遇到的常见http 请求需求，做了简单的封装，不做过度设计, 特点是：
> - 链式调用
> - 响应处理
> - 原始响应缓存
> - 易于复用

## 代码实现
```go
package httpx

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"

	"github.com/rs/zerolog/log"
)

type HttpClientX struct {
	header        http.Header
	query         map[string]string
	tmpBody       *bytes.Buffer
	tmpResp       *bytes.Buffer
	respStautCode int
	respErr       error
}

func NewHttpClientX() *HttpClientX {
	return &HttpClientX{
		header:  make(http.Header),
		query:   make(map[string]string),
		tmpBody: bytes.NewBuffer(nil),
		tmpResp: bytes.NewBuffer(nil),
	}
}

func (h *HttpClientX) SetHeader(k, v string) *HttpClientX {
	h.header.Set(k, v)
	return h
}

func (h *HttpClientX) ClearHeader() *HttpClientX {
	h.header = make(http.Header)
	return h
}
func (h *HttpClientX) SetContentType(v string) *HttpClientX {
	h.header.Set("Content-Type", v)
	return h
}
func (h *HttpClientX) AddHeader(k, v string) *HttpClientX {
	h.header.Add(k, v)
	return h
}
func (h *HttpClientX) SetAuthorization(v string) *HttpClientX {
	h.header.Set("Authorization", v)
	return h
}

func (h *HttpClientX) SetQuery(k, v string) *HttpClientX {
	h.query[k] = v
	return h
}

func (h *HttpClientX) ClearQuery() *HttpClientX {
	h.query = make(map[string]string)
	return h
}

func (h *HttpClientX) Post(url string, obj any) *HttpClientX {
	return h.request("Post", url, obj)
}

func (h *HttpClientX) Get(url string) *HttpClientX {
	return h.request("Get", url, nil)
}

func (h *HttpClientX) Put(url string, obj any) *HttpClientX {
	return h.request("Put", url, obj)
}

func (h *HttpClientX) Delete(url string, obj any) *HttpClientX {
	return h.request("Delete", url, obj)
}

func (h *HttpClientX) request(method, url string, obj any) *HttpClientX {
	var body io.Reader
	if obj != nil {
		h.tmpBody.Reset()
		buf, err := json.Marshal(obj)
		if err != nil {
			log.Error().Err(err).Msg("SetBody")
			return h
		}
		h.tmpBody.Write(buf)
		body = h.tmpBody
	}

	req, err := http.NewRequest(method, url, body)
	if err != nil {
		log.Error().Err(err).Msg(method)
		h.respErr = err
		return h
	}

	if h.header["Content-Type"] == nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range h.header {
		if len(v) == 1 {
			req.Header.Set(k, v[0])
		}
	}
	if len(h.query) > 0 {
		q := req.URL.Query()
		for k, v := range h.query {
			q.Set(k, v)
		}
		req.URL.RawQuery = q.Encode()
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Error().Err(err).Msg(method)
		h.respErr = err
		return h
	}
	defer resp.Body.Close()
	h.respStautCode = resp.StatusCode
	h.tmpResp.Reset()
	_, err = io.Copy(h.tmpResp, resp.Body)
	if err != nil {
		log.Error().Err(err).Msg(method)
		h.tmpResp.Reset()
		h.respErr = err
		return h
	}
	return h
}

// 应该是用指针对象
func (h *HttpClientX) Then(obj any) *HttpClientX {
	if h.respErr != nil {
		return h
	}
	if len(h.tmpResp.Bytes()) == 0 {
		return h
	}
	if err := json.Unmarshal(h.tmpResp.Bytes(), obj); err != nil {
		log.Error().Err(err).Msg("Then")
		h.respErr = err
	}
	return h
}

func (h *HttpClientX) Catch(errHandle func(error)) *HttpClientX {
	if h.respErr != nil {
		errHandle(h.respErr)
	}
	return h
}

func (h *HttpClientX) GetRawResp() string {
	return h.tmpResp.String()
}

func (h *HttpClientX) GetStatusCode() int {
	return h.respStautCode
}

```
## 使用注意
1. 先设置 header 和 query
2. 可以设置  Content-Typ
3. 然后通过 POST/PUT/GET/DELETE 发起实际请求
4. 通过 Then 和 Catch 来解析响应类型，这里只是简单的做了Json 解析，可以自行扩展
5. 可以通过`GetRawResp`和`GetStatusCode` 获取原始响应和 响应状态码，避免json 解析错误后丢失原始内容