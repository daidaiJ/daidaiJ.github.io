---
title: "过机器人检测对照实测：脚本与测试方案"
slug: websearch-antibot-bench
description: ""
date: 2026-09-12T11:02:00+08:00
lastmod: 2026-09-12T11:02:00+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories:
    - 技术笔记
    - ai
tags:
    - 反爬
    - python
    - 测试
image: https://picsum.photos/seed/e92866f1/800/600
---
# 过机器人检测对照实测：脚本与测试方案
------
> agent 的搜索和抓取路径迟早撞盾：Cloudflare、雷池、DataDome、百度 wappass。网上一搜全是"某隐身浏览器无敌"的传说，但没人给得出可复现的对照数据。这篇记录我在 websearch-mcpserver 里搭的一套实测：脚本怎么组织、判定怎么下、哪些坑会让你得出错误结论。实测日期 2026-09-12，结论绑定当天的出口（家宽直连 + HK 代理），挑战站策略会变，方法比数字保值。

## 要回答的问题

------
核心问题只有一个：**在搜索热路径和抓取路径上，隐身浏览器方案到底比 TLS 指纹伪装多过多少东西？值不值得上？**

网上答案两极：要么"过不了 Cloudflare，别想了"，要么"nodriver 完爆一切"。都不带出口环境、不带判定标准。要自己测，先固定变量：

- **出口**：家宽直连 vs HK 代理（`127.0.0.1:7897`），分开记录。后面会看到出口 IP 信誉比任何指纹都重要
- **IP 状态**：冷启动 vs 打热。同一 IP 连打十几分钟后，裸 HTTP 的基线表现都会变
- **后端矩阵**：裸 HTTP、curl_cffi（`impersonate=chrome`）、Playwright/Patchright + 系统 Edge、nodriver/zendriver + 系统 Edge headed、Camoufox（魔改 Firefox）、CloakBrowser（魔改 Chromium）、SeleniumBase UC
- **目标**：搜索站（思否/百度/Google）+ 挑战页矩阵（九种盾各选一个代表）

整个研究放在 `tmp/antibot-research/`（gitignore，不进发行物），四个脚本分工：

```
run_bench.py            # 搜索站对照：统一框架 + 9 个浏览器后端
run_challenges.py       # 挑战页矩阵：复用 bench 框架，换目标换判定
probe_baidu_binsearch.py # 百度限流探测：恢复窗口二分搜索
baseline/               # Go 侧 go-webfetch 的对照基线
artifacts/              # 每次响应的 HTML 全量落盘
```

## 统一框架：一个 Result 走天下

------
`run_bench.py` 的骨架很朴素：一个 dataclass 记录所有证据，一个注册表挂后端，一个判定函数下结论。

```python
@dataclass
class Result:
    backend: str
    target: str
    url: str
    proxy: str
    status: int = 0
    final_url: str = ""      # 重定向后的最终 URL，wappass/sorry 全靠它
    bytes: int = 0
    elapsed_ms: int = 0
    verdict: str = "ERROR"   # OK / BLOCKED / GATED
    reason: str = ""         # 机器可读的原因签名
    error: str = ""
    snippet: str = ""
    artifact: str = ""       # HTML 落盘路径
    title: str = ""
    evidence: str = ""       # 抽出来的有机结果标题
```

设计上三个决定后来证明都很关键：

1. **`final_url` 单独记**。百度验证码是 200 + 重定向到 `wappass.baidu.com`，Google 是 200 + `/sorry/`。只看 status code 会把 BLOCKED 判成 OK
2. **`evidence` 记有机结果标题**。判定"拿到了真实 SERP"的证据不是"页面很大"，而是抽得出真实的 `<h3>` 标题链
3. **每次响应全量落盘 `artifacts/`**。事后发现判定可疑时可以人工复判，不用重跑（重跑会污染 IP 状态）

后端全部挂进一张注册表，跑哪个选哪个：

```python
BACKENDS: dict[str, Callable[[str, str, str], Result]] = {
    "curl_cffi": run_curl_cffi,
    "playwright": lambda t, u, p: run_playwright(t, u, p, headed=False),
    "patchright": lambda t, u, p: run_patchright(t, u, p, headed=True),
    "nodriver":   lambda t, u, p: run_nodriver(t, u, p, headed=True),
    "zendriver":  lambda t, u, p: run_zendriver(t, u, p, headed=True),
    "camoufox":   lambda t, u, p: run_camoufox(t, u, p, headed=False),
    "cloakbrowser": lambda t, u, p: run_cloakbrowser(t, u, p, headed=True),
    "seleniumbase": lambda t, u, p: run_seleniumbase(t, u, p, headed=True),
}
```

主循环里有个细节：一个后端在某出口下失败后，自动换备用出口再试一次（Google 除外——直连必然超时，没必要试）：

```python
if not args.no_fallback_proxy and target != "google" and r.verdict in {"BLOCKED", "ERROR", "GATED"}:
    alt = fallback_proxy(target)
    if alt != proxy:
        time.sleep(1.2)
        r2 = safe_run(fn, target, url, alt, backend)  # 换出口重打一次
```

这样每行结果自带出口标签（`proxy` / `direct`），对照矩阵一张表读完。`safe_run` 把异常也变成一条 ERROR 记录而不是炸掉整个跑批——九个后端有一个装不上环境太正常了。

## 判定器：看内容，不看状态码

------
这是整个测试方案最容易做错的地方。三态判定：

- **OK**：拿到了目标内容本体（有机结果 / 题干正文）
- **BLOCKED**：命中验证码 / JS 挑战 / 盾页签名
- **GATED**：HTTP 200 但拿到的不是目标内容（站点壳、登录墙、空壳 JS）

> GATED 这个中间态是被迫发明的。思否问答页在 nodriver 下返回 200 + 8KB 的站点壳——有站点导航没有题干。按"HTTP 200 即成功"的朴素标准这就是过了，实际 agent 拿到的是废物。200 和"拿到内容"之间隔着一整个 JS 渲染的世界。

BLOCKED 靠签名库，全是实测中收集的真实特征：

```python
if "wappass.baidu.com" in final_low or title == "百度安全验证":
    return "BLOCKED", "baidu_wappass_captcha"
if "/sorry" in final_low or "unusual traffic" in low:
    return "BLOCKED", "google_sorry_captcha"
if title.strip() in {"just a moment...", "just a moment"} or "cf-browser-verification" in low:
    return "BLOCKED", "cloudflare_js_challenge"
if "captcha-delivery.com" in low:
    return "BLOCKED", "datadome_captcha"
if status == 429 and ("kpsdk" in low or "unwanted automated" in low):
    return "BLOCKED", "kasada_429"
if "zse-ck" in low and status >= 400:
    return "BLOCKED", "zhihu_zse_ck"
```

> 顺序有讲究：`challenge-platform` 这类词会出现在正常文章正文里（比如一篇讲 Cloudflare 的技术文章），所以签名判定必须放前面、且带范围条件。思否的目标 originally 标错成 Cloudflare，实测发现是 Tengine + Next.js SSR——这就是为什么判定不能只靠关键词猜。

OK 的判定最严，必须看到**目标内容本身**。百度 SERP 的标准：

```python
def baidu_organic_ok(body: str) -> tuple[bool, str]:
    n_op = body.lower().count("result-op")       # 有机结果容器计数
    titles = h3_texts(body, 8)                   # 抽出 h3 标题
    blob = " ".join(titles).lower()
    has_query = "golang" in body.lower() or "go 语言" in body
    has_real = any(k in blob or k in body.lower()
                   for k in ("github", "baike", "programming language", ...))
    if n_op >= 3 and has_query and has_real:
        return True, f"serp_results={n_op}; " + " | ".join(titles[:4])
    return False, f"thin_or_warning op={n_op} titles={titles[:3]}"
```

三个条件缺一不可：只有 `result-op` 计数会被假结果页骗到；只有查询词会出现"正文里提到 golang"的假阳性；只有标题匹配会撞到推荐位。三个同时成立才敢判 OK，且把抽到的标题写进 `evidence` 字段——每条 OK 结论都带人眼可查的证据。

## 换目标不换框架

------
挑战页矩阵（`run_challenges.py`）要打九个不同的盾，但没有另起炉灶——直接 monkey-patch 掉 bench 框架的判定和目标：

```python
import run_bench as rb

def judge_challenge(target, status, final, body):
    ...  # 每种盾自己的签名

rb.judge = judge_challenge             # 替换判定
rb.preferred_proxy = preferred_proxy   # 海外目标走 HK 代理
rb.TARGETS = {k: CHALLENGES[k]["url"] for k in CHALLENGES}
```

每个挑战站声明四件事：URL、走不走代理、盾类型、过盾判据（needle 词）：

```python
CHALLENGES = {
    "leboncoin_dd":  {"url": "https://www.leboncoin.fr/", "proxy": True,
                      "kind": "datadome", "ok": ("leboncoin", "annonces")},
    "sf_safeline":   {"url": "https://segmentfault.com/q/1010000048290204", "proxy": False,
                      "kind": "safeline", "ok": ("问答", "回答")},
    "sannysoft_fp":  {"url": "https://bot.sannysoft.com/", "proxy": True,
                      "kind": "fingerprint", "ok": ("antibot", "sannysoft")},
    ...
}
```

九个挑战覆盖九种防线：Cloudflare JS 挑战（GitLab 登录、nowsecure）、DataDome 验证码（G2）和内容页（leboncoin）、Kasada（Hyatt）、知乎 zse-ck、雷池（思否问答）、指纹表（sannysoft）、Turnstile。kind 字段驱动判定分支——指纹表和 Turnstile 没有"过"可言，永远只给 GATED（`fingerprint_fails≈28` / `turnstile_widget_unsolved`），只是拿数据对比各后端的指纹质量。

实测矩阵（2026-09-12，HK 代理）：

| 挑战 | curl_cffi | nodriver/zendriver headed | Camoufox | CloakBrowser |
|------|-----------|---------------------------|----------|--------------|
| leboncoin（DataDome 内容页） | 403 | **OK ~477KB** | OK | OK |
| Hyatt（Kasada） | 429 | 200 空壳 ~0.8KB | 429 | 429 |
| 知乎专栏（zse-ck） | 403 | 200，但是 404「荒原」 | 403 | 403 |
| 思否问答（雷池） | 468 | 468 壳 | 468 | 468 |
| nowsecure（Cloudflare） | 页脚挂 challenge-platform | 同左 | 同左 | 同左 |
| Turnstile | 未解 | 未解 | 未解 | 未解 |

> 这张表是整套测试最有价值的产出：浏览器方案的真实增量只有"部分 DataDome 内容页"。Cloudflare managed、Kasada 有效内容、雷池、Turnstile 一个都没过。而像"知乎从 403 变成 200"这种看起来像进步的结果，判定器一查正文是 404 荒原页——GATED，不是 OK。没有判定器，这张表会乐观得多。

## 百度探测：二分爬速与观察者效应

------
前两个脚本回答"能不能过"，`probe_baidu_binsearch.py` 回答另一个问题：**家宽 IP 被打热进 wappass 后，多久能恢复？恢复后能容忍多快的请求速率？**

思路是把限流阈值当成未知量做二分搜索：

```python
COOLDOWN_S = 6 * 60        # 每个新阈值前等 6 分钟"恢复"
START_INTERVAL_S = 60      # 从保守的 1 req/min 起步
LADDER_S = [60, 30, 20, 15, 10, 8, 5, 3, 2]  # 逐级爬快
STOP_GAP_S = 2             # fail-ok 间隔 ≤2s 就停

# 1. 恢复：每 6 分钟一个请求，直到出现真实 SERP
# 2. 爬速：从 60s 间隔逐级加速
# 3. 触发 wappass：在 last-good 和 last-fail 之间二分
# 4. 状态持久化到 JSON，可断点续跑
```

每个请求随机换查询词（十个编程语言话题轮着来），避免同一查询词本身触发风控。状态写 `baidu-binsearch-state.json`，中断了接着跑——毕竟每个观察点要等 6 分钟。

结果是否定的，而且否定的方式很有意思：**探测本身消灭了被探测的现象**。6 分钟间隔回探 6 次（约 36 分钟）全部 wappass——每一次回探都在向百度确认"这个 IP 还在自动化访问"，把 IP 继续钉在验证码里。找不到可运营的恢复窗口，实验就此停手，脚本头部留了句话：

```
Do not loosen production clamps from a single lucky window.
```

> 这是整套实测里最反直觉的一课：对风控系统做测量，测量行为本身就是被测变量的一部分。物理实验里有观察者效应，反爬风控这里更直接——你的探针就是风控的输入。想清楚这一点，就不难理解为什么仓库里百度网页引擎的限流钳制（1/s · 6/min + 2s 最小间隔）是硬编码钳制、不提供放宽配置：宽松值钳到上限，更严的配置才生效。

## 方法论教训

------
最后把方案层面踩过的坑归拢一下，再测这类东西直接对照：

1. **判定看有机结果，不看体积和状态码**。nowsecure 返回过 200 + 大体积页面，页脚仍挂着 `challenge-platform`；思否文章正文里全是 "checking your browser" 字样——体积、状态码、关键词三者都会骗人，OK 判定必须锚定目标内容本身的结构特征
2. **冷启动和热 IP 必须分开记录**。家宽冷启动裸 HTTP 就能拿百度 SERP，连打十余次后连直连都进 wappass。同一位后端在两种状态下的"成绩"可以完全不同，混在一起测等于没测
3. **出口比指纹重要**。走脏代理（HK 机房 IP）时，裸 HTTP 和隐身浏览器的表现差距远小于预期——百度、Google、Cloudflare、DataDome 的 captcha 都强绑出口 IP 信誉，TLS 指纹和浏览器伪装补不了这个
4. **每轮之间要 sleep，且把间隔写进脚本**。1.0~1.2s 的请求间隔不是礼貌，是防止实验自己把 IP 打热、污染后面所有轮次
5. **全量落盘 + 证据字段**。所有 OK/BLOCKED 结论都能从 `artifacts/` 里的原始 HTML 和 `evidence` 字段人工复核。反爬站点的判定太容易自欺，可复判是底线
6. **结果绑定日期和出口**。挑战站策略按周变，这篇的数字只在 2026-09-12 的家宽 + HK 代理出口下成立。脚本能重跑，结论不能抄

> 一句话版本：这套脚本真正测出来的不是"哪个隐身浏览器最强"，而是**在真实出口环境下，浏览器方案对搜索热路径的增量接近于零**。至于哪一层手段过哪类盾的完整边界，那是另一个话题了。
