---
title: "统计大模型流式响应的token usage"
slug: "sse-usage"
description: "how to collect usage of sse response"
date: 2026-04-15T15:33:03+08:00
lastmod: 2026-04-15T15:33:03+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["ai"]
tags: ["python","http"]
image: https://picsum.photos/seed/fd9c5bb3/800/600
---
# LLM 流式响应的 usage 怎么统计？
> 以Openai api 为例

现在大模型流式输出应用很广泛了，很多webui 上附加的打字机效果，视觉体验确实好。但是这种场景下咋统计大模型的token 用量

这里简单分享一下个人的拙作。

---
## SSE 响应格式的特点

Server-Sent Events（SSE）是一种基于 HTTP 的轻量级单向实时通信协议。在 OpenAI API 中，流式响应以 SSE 格式传输，每个分块的结构如下：

```
data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{"content":"某"},"finish_reason":null}]}
```

关键特点：

- 每个分块是一行以 `data:` 开头的文本
- 最后一个分块固定为 `data: [DONE]`，标志流结束
- 分块之间可能穿插空行
- 响应头中 `content-type: text/event-stream`，`transfer-encoding: chunked`

---

## usage 怎么获取


大多数 LLM API（OpenAI、以及各种兼容 API）在开启流式响应时，**不会在第一个分块里就把 usage 返回**。而是会在流快结束、发送 `[DONE]` 之前，插一个特殊的分块。这个分块大概长这样：

```json
data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":27,"total_tokens":38,"prompt_tokens_details":{"cached_tokens":0}}}
```

可以看到：
- `delta` 是空的 `{}`，不是 null
- `finish_reason` 变成了 `"stop"`
- 整块的 `usage` 信息就在这儿

这就是核心：**usage 信息不是元数据单独发过来的，而是塞在流结束前的上个分块里。** 。

---

## 滚动更新缓存

既然 usage 必然出现在 `[DONE]` 之前，只要在收到 `[DONE]` 时，解析缓存的最后一个分块就行了。

思路：

1. 收到正常分块 → 放进队列，队列满了就踢掉最老的
2. 收到 `[DONE]` → 队列里的一定有 usage，直接取出来解析

用队列（maxsize=2）来实现，代码如下：

```python
import httpx
import json
import queue


def stream_chat_completion(base_url: str, sk: str, model: str, messages: list):
    """
    流式请求 OpenAI /v1/chat/completions 接口，
    用大小为 2 的队列缓存 SSE 分块，解析 usage。

    Args:
        base_url: API 基础地址
        sk: 模型密钥sk
        model: 模型名称
        messages: 对话消息列表
    """
    url = f"{base_url.rstrip('/')}/v1/chat/completions"

    payload = {
        "model": model,
        "messages": messages,
        "stream": True
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {sk}",
    }

    print(f"请求地址: {url}")
    print(f"请求体: {json.dumps(payload, ensure_ascii=False, indent=2)}")
    print("-" * 50)
    print("开始接收 SSE 流:")
    print("-" * 50)

    with httpx.stream(
        "POST",
        url,
        json=payload,
        headers=headers,
        timeout=60.0
    ) as response:
        print(f"状态码: {response.status_code}")
        print(f"响应头: {dict(response.headers)}")
        print("-" * 50)

        # 关键：用队列只保留最近 2 个分块
        records: queue.Queue[str] = queue.Queue(maxsize=2)

        for line in response.iter_lines():
            if line:
                if line.startswith("data:"):
                    data = line[5:].strip()
                    if data == "[DONE]":
                        print("得到 [SSE] 流结束信号: [DONE]")
                        try:
                            item = records.get()
                            parsed = json.loads(item)
                            usage = parsed.get("usage", {})
                            if usage:
                                output_token = usage.get("completion_tokens", 0)
                                input_token = usage.get("prompt_tokens", 0)
                                cached_token = usage.get("cached_tokens")
                                prompt_tokens_details = usage.get(
                                    "prompt_tokens_details", {}
                                ).get("cached_tokens")
                                if not cached_token and prompt_tokens_details:
                                    cached_token = prompt_tokens_details
                                print(
                                    f"[解析后] output_token={output_token}, "
                                    f"input_token={input_token}, cached_token={cached_token}"
                                )
                            while not records.empty():
                                s = records.get_nowait()
                                print(s)
                        except json.JSONDecodeError:
                            print(f"[解析失败] 无法解析 JSON: {data}")
                    else:
                        # 队列满了就丢弃旧数据，只保留最新的
                        if not records.empty():
                            records.get(block=False)
                        records.put(data)
                else:
                    print(f"[其他] {line}")


if __name__ == "__main__":
    BASE_URL = "https://api.example.com"
    MODEL = "gpt-3.5-turbo"
    MESSAGES = [{"role": "user", "content": "用一句话介绍 Python 3.11"}]
    SK = "your-api-key"

    stream_chat_completion(BASE_URL, SK, MODEL, MESSAGES)
```

跑一下，大概是这种输出：

```
请求地址: https://api.example.com/v1/chat/completions
请求体: {
  "model": "gpt-3.5-turbo",
  "messages": [{"role": "user", "content": "用一句话介绍Python 3.11"}],
  "stream": true
}
--------------------------------------------------
开始接收 SSE 流:
--------------------------------------------------
状态码: 200
响应头: {'server': 'openresty', 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked'}
--------------------------------------------------
得到 [SSE] 流结束信号: [DONE]
[解析后] output_token=27, input_token=11, cached_token=0
```

这样就拿到usage和主要的输入/缓存/输出token 量了，其实还可以顺带统计下api 请求次数，现在很多coding plan 是基于api 调用次数计量的 。

---

## 其实一个变量就够了

回过头来看，队列大小设成 2 有点多余。

usage 分块是 `[DONE]` 之前**唯一**一个 `delta` 为空的块，而且它和 `[DONE]` 之间不会再有其他有效数据了。所以我们只需要记住最近收到的那个 `data:` 行就行，不需要队列。

单变量版：

```python
last_chunk = None
for line in response.iter_lines():
    if line and line.startswith("data:"):
        data = line[5:].strip()
        if data == "[DONE]":
            if last_chunk:
                usage = json.loads(last_chunk).get("usage", {})
                print(f"input={usage.get('prompt_tokens')}, output={usage.get('completion_tokens')}")
        else:
            last_chunk = data
```

逻辑是一样的，只是把"最多两个"换成了"就一个"——反正够用。空间复杂度直接从 O(2) 变成 O(1)，虽然实际差别微乎其微，但写出来更干净。

---

## 适用场景

想了一下，大概是这么几类场景：

**API 代理或网关**。转发流的时候想顺便记个 token 用量，没必要把整个响应缓存下来再处理，拿到 usage 直接记了就行。

**轻量级 SDK**。不想维护一个大的缓冲区，特别是并发量大的时候，内存省一点是一点。

**成本统计/监控**。实时统计每个请求的消耗，而不是事后去日志里翻。

**调试工具**。快速跑一个请求，看看某个模型实际消耗了多少 token，做个对比什么的。

基本上，只要你需要在流式响应的同时拿到 usage，而又不打算存完整的流，这个思路都能用。

---



其实核心就一句话：**usage 信息是在 `[DONE]` 的上个分块里一起过来的**。理解这个要点，用一个变量（或两个元素的队列）就能拿到，完全不需要缓存整个流。当然实际开发中怎么用，看你心情。追求简洁就一个变量，想留点冗余空间方便以后加日志就队列，两种写法都行，理解原理最重要。
