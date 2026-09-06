---
title: "OpenSandbox 源码走读（四）：出口网络——NetworkPolicy、Egress Sidecar 与池化出口"
slug: opensandbox-4-egress
description: ""
date: 2026-09-06T20:10:55+08:00
lastmod: 2026-09-06T20:10:55+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories:
    - 技术笔记
    - kubernetes
tags:
    - opensandbox
    - k8s
    - sandbox
    - ai-agent
image: https://picsum.photos/seed/03153fdb/800/600
---
# OpenSandbox 源码走读（四）：出口网络——NetworkPolicy、Egress Sidecar 与池化出口
------
> 沙箱平台最尴尬的问题之一：用户在沙箱里跑的代码是不可信的，但它偏偏需要出网——调 LLM API、拉 GitHub、装 pip 包。这一篇讲 OpenSandbox 怎么管住这条出口：先拆 egress sidecar 的内部实现，再对比 K8s 原生 NetworkPolicy 为什么不行，最后是我结合自己 Higress 背景想聊的池化出口 + 网关分层方案。

## egress sidecar：共享 netns 的透明拦截器
------
> egress 是按需挂载的 Go sidecar（`components/egress/`），和沙箱应用容器共享网络命名空间。它的定位很克制：只做 L3/L4 + DNS 层的出口管控，L7 明确不做。

先看它什么时候会被挂进 Pod。`server/opensandbox_server/services/k8s/egress_helper.py`：

```python
def apply_egress_to_spec(..., network_policy, egress_image, ...):
    if not network_policy or not egress_image:
        return  # 两个条件缺一个，egress 根本不会出现
```

也就是：请求带了 `network_policy`，且 server 配了 `[egress] image`，才有 sidecar。不传策略的沙箱出站完全不受限——这是个容易误解的默认行为，管控是 opt-in 的。

安全模型的核心在同一个文件里：

```python
def build_security_context_for_sandbox_container(has_network_policy, ...):
    if not has_network_policy:
        ...
    return {
        "capabilities": {"drop": ["NET_ADMIN"]},
    }
```

启用网络策略时，server 会把**沙箱容器的 `NET_ADMIN` 摘掉**，只有 egress sidecar 保留——沙箱里跑的恶意代码没法自己改 iptables 绕过拦截。这一手比任何规则配置都重要，规则再严，用户能改规则就全白搭。

启动流程在 `components/egress/main.go`，顺序即依赖：

```go
initialRules, _, err := policy.LoadInitialPolicyDetailed(...)
if err != nil {
    log.Fatalf("failed to load initial egress policy: %v", err)  // fail-closed
}
alwaysDeny, alwaysAllow, err := policy.LoadAlwaysRuleFiles()
...
proxy.Start(ctx)                          // DNS 代理先起，127.0.0.1:15353
...
if err := iptables.SetupRedirect(15353, exemptDst); err != nil {
    log.Fatalf("failed to install iptables redirect: %v", err)
}
setupNft(...)                             // dns+nft 模式下加载 nftables 链
...
policySrv, err := startPolicyServer(...)  // HTTP API :18080
mitm, err := startMitmproxyTransparentIfEnabled()  // 可选，实验特性
```

值得注意的失败模式：**全链路 fail-closed**。初始策略解析失败、iptables 装不上、nft 加载失败，一律 `log.Fatalf` 退出，靠 supervisor 重启——宁可沙箱不可用，不带病放行。早期 OSEP 里"没有 CAP_NET_ADMIN 时降级继续运行"的设计已经废弃了，现在 `/healthz` 不就绪的 Pod 根本不会被分配流量。

------
> 熟悉我的老读者知道我写过 Higress 的 failover 逻辑，所以看到 egress 的 DNS 上游处理时有点亲切感：NXDOMAIN/NOERROR 不重试（这是权威答案），其他 rcode 才 failover 到下一个上游。语义是对的。

## 两层拦截：DNS 代理 + nftables 动态放行
------
> egress 的核心思路是把"域名白名单"这个 L7 概念拆成两层落地：DNS 层管域名，IP 层管连接。策略模型本身只有 `action` + `target` 两个字段。

策略解析在 `components/egress/pkg/policy/policy.go`：

```go
func normalizePolicy(p *NetworkPolicy) error {
    ...
    if ip, err := netip.ParseAddr(r.Target); err == nil {
        r.targetKind = targetIP      // 纯 IP
        r.ip = ip
        continue
    }
    if prefix, err := netip.ParsePrefix(r.Target); err == nil {
        r.targetKind = targetCIDR    // CIDR
        r.prefix = prefix
        continue
    }
    // 否则按域名处理
```

`specs/egress-api.yaml` 里那句 "IP/CIDR not yet supported in the egress MVP" 是**过时注释**，实现早就支持了。另外 `ParsePolicy` 对空策略的处理是 `"" / null / {} → DefaultDenyPolicy()`——空策略即 deny-all，不会手滑变成全放行。

**Layer 1：DNS 代理**。iptables 把所有 53 端口流量重定向到本机代理（`pkg/iptables/redirect.go`）：

```go
{"iptables", "-t", "nat", op, "OUTPUT", "-p", "udp", "--dport", "53",
    "-m", "mark", "--mark", constants.MarkHex, "-j", "RETURN"},   // ← 防自递归
{"iptables", "-t", "nat", op, "OUTPUT", "-p", "udp", "--dport", "53",
    "-j", "REDIRECT", "--to-port", targetPort},
```

代理自己向上游发的查询打上 mark 先 RETURN 跳过，否则会无限套娃。上游地址必须是字面 IP，hostname 会再次命中重定向。IPv4/IPv6 双栈都装，nft 后端装不上 iptables 时还有一套原生 nft redirect 回退（`opensandbox_dns_redirect` 表）。

被拒域名在 `pkg/dnsproxy/proxy.go` 的处理：

```go
if currentPolicy != nil && currentPolicy.Evaluate(domain) == policy.ActionDeny {
    telemetry.RecordDNSDenied()
    p.publishBlocked(domain)
    resp := new(dns.Msg)
    resp.SetRcode(r, dns.RcodeNameError)   // 被拒 = NXDOMAIN
    _ = w.WriteMsg(resp)
    return
}
```

**Layer 2：nftables**（`dns+nft` 模式）。`pkg/nftables/manager.go` 的 `buildRuleset` 生成的链结构：

```
ct state established,related accept      # 存量连接放行，策略变更不掐断
meta mark <MarkHex> accept               # 代理自身流量
oifname "lo" accept                      # 回环
ip daddr 127.0.0.1 udp/tcp dport 15353 accept
tcp/udp dport 853 drop                   # DoT 默认阻断，防 DNS 绕过
ip daddr @deny_v4/v6 drop                # 静态 deny 集
ip daddr @dyn_allow_v4/v6 accept         # 动态 allow 集（DNS 解析产物）
ip daddr @allow_v4/v6 accept             # 静态 allow 集
drop                                     # defaultAction: deny 兜底
```

动态集的 TTL 设计在 `pkg/nftables/dynamic.go`：

```go
const (
    dynSetTimeoutS = 360
    nftTTLSlackSec = 60   // 比 resolver 缓存多活 60s，减少竞态
    minTTLSec      = 60
    maxTTLSec      = 360  // max DNS TTL (300) + slack
)

func clampTTL(d time.Duration) time.Duration {
    sec := int(d.Seconds()) + nftTTLSlackSec
    sec = min(max(sec, minTTLSec), maxTTLSec)
    return time.Duration(sec) * time.Second
}
```

放行的域名解析出的 IP 带 TTL 进动态集；连接跟踪器每 30s 扫 `/proc` 里的活跃 TCP 连接续期（只跟踪 TCP，UDP/QUIC 靠 DNS TTL 自然过期）。还有一个容易忽略的时序细节，`proxy.go` 的注释写得很明白：

```go
// maybeNotifyResolved calls onResolved before w.WriteMsg so dynamic nft allows are installed
// before the client receives the answer and may open a connection.
```

nft 放行在 DNS 响应**返回给客户端之前**同步完成——否则客户端拿到 A 记录立刻建连，会被还没更新的 nft 规则丢掉，变成玄学超时。

------
> 这套设计的弱点也很清楚：IP/CIDR 规则只在 `dns+nft` 模式生效，纯 `dns` 模式下 DNS 层直接跳过非域名规则。另外端口维度完全没有——`NetworkRule` 就没有 port 字段，后面讲 Higress 分层时会回到这个问题。

## 为什么不用 K8s NetworkPolicy
------
> 这是官方 `docs/architecture/network-isolation.md` 里明确的选择，我在源码层面核了一遍，结论成立：不是 NetworkPolicy 不好，是它的语义模型和沙箱场景不匹配。

| 维度 | K8s NetworkPolicy | egress sidecar |
|---|---|---|
| 控制点 | 集群网络层（CNI 数据面） | 沙箱 Pod 内部（共享 netns） |
| 控制对象 | Pod 集合（namespace + label selector） | 单个沙箱（per-sandbox） |
| 域名级控制 | 原生不支持（需 Cilium `toFQDNs` 扩展） | 原生支持 FQDN 白名单 |
| 动态调整 | 静态 YAML，改规则要 apply | 运行时 API（`POST/PATCH /policy`）实时生效 |
| 平台/用户双层 | 只有平台级（集群管理员 RBAC） | `deny.always`（平台不可覆盖）+ 用户策略 |
| 额外开销 | 无 | 每沙箱多一个容器 + `NET_ADMIN` 攻击面 |
| gVisor 兼容 | 无关（运行时透明） | 不兼容（netstack 不实现 iptables nat 表） |

三个致命的不匹配：

**一，label 不可预测。** 沙箱 Pod 的 label 由平台自动注入，不同租户/安全级别的沙箱可能共享同一套 label。NetworkPolicy 靠 label selector 划边界，边界本身不可控，规则写得再细也是空中楼阁。

**二，生命周期错位。** 沙箱秒级创建销毁，NetworkPolicy 是静态声明。"默认拒绝来自所有其他沙箱的访问"是 per-sandbox 语义，用 Pod 集合语义表达要为每个沙箱单独建规则，且永远覆盖不到下一个创建的沙箱。

**三，出站控制天然弱。** NetworkPolicy 的 Ingress 能挡入站，但挡不住沙箱进程主动 `curl` 另一个沙箱的 Pod IP。要挡出站得 Ingress+Egress 双向配，又绕回前两个问题。而沙箱场景最常用的"允许访问 `api.github.com`"这种域名规则，原生根本不支持。

再往下挖一层是语义差异。NetworkPolicy 是**网络管理员视角**——"这个网段允许访问那个网段"；egress 是**沙箱视角**——"这个沙箱允许访问哪些域名"。多租户场景里用户根本不该知道集群的 Pod/Service CIDR（这本身是敏感信息），egress 让用户只声明域名，CIDR 知识留在平台侧。

一个实际的细节：启用策略时 server 摘掉沙箱容器 `NET_ADMIN`、只留给 sidecar（前面贴过的 `build_security_context_for_sandbox_container`），所以沙箱内进程无法绕过。NetworkPolicy 场景下这个前提都不需要，因为策略在集群层，沙箱内根本摸不到。

**但 egress 的代价也要列清楚：**

| 缺点 | 说明 |
|---|---|
| 需要 `NET_ADMIN` | 只给 sidecar，但镜像/部署复杂度和审计面是实打实增加的 |
| 与 gVisor 不兼容 | netstack 没有 iptables nat 表，REDIRECT 无效；只能改 Kata 或 CNI 级 FQDN 策略 |
| 与透明 mesh 冲突 | Istio/Envoy sidecar 同在一个 netns 重写流量，二选一 |
| 资源开销 | 每个受控沙箱多一个容器（内存/CPU/镜像拉取） |
| 只管出站 | 沙箱间入站隔离仍要靠 `deny.always` 挡 Pod CIDR 间接实现 |

> 我的判断：OpenSandbox 选 egress 当主力不是"sidecar 模式先进"，而是沙箱平台的三要素——多租户、动态生命周期、域名级出站白名单——每一个都踩在 NetworkPolicy 的语义盲区上。NetworkPolicy 合理的位置是补充：集群内入站隔离、挡 Pod CIDR，跟 Cilium 这类 CNI 配合做 egress 方案的降级备选（gVisor 场景）。

## 池化模式：策略必须预置进模板
------
> 池化（Pool）是预热沙箱的经典套路——先创建一批 Pod 备着，请求来了直接分配。但这和"创建时注入 sidecar"天然冲突：Pod 已经存在了，生命周期 API 没法往里塞容器。

约束很硬：`networkPolicy` 与 `extensions.poolRef` 同时使用会被 server 直接拒绝（HTTP 400）。正确做法是把 egress 容器手动写进 Pool 的 `spec.template`（完整 `corev1.PodTemplateSpec`，Schemaless 原样透传）：

```yaml
- name: egress
  image: opensandbox/egress:v1.1.6
  securityContext:
    capabilities:
      add: ["NET_ADMIN"]        # 缺失则 sidecar 启动失败（fail-closed）
  env:
    - name: OPENSANDBOX_EGRESS_MODE
      value: "dns+nft"          # IP/CIDR 规则仅此模式生效
    - name: OPENSANDBOX_EGRESS_RULES
      value: '{"defaultAction":"deny","egress":[{"action":"allow","target":"api.github.com"}]}'
    - name: OPENSANDBOX_EGRESS_TOKEN
      value: "<token>"          # 不设则 18080 无认证，能连上就能改策略
  readinessProbe:
    httpGet: {path: /healthz, port: 18080}
```

由此带来几个池化特有的坑：

| 坑 | 后果 |
|---|---|
| 所有沙箱共享模板策略 | 每请求独立的 `network_policy` 在 pool 模式不生效，模板级统一管控 |
| `OPENSANDBOX_EGRESS_SANDBOX_ID` 无法注入 | egress 审计/deny webhook 的 payload 里 `sandboxId` 为空，无法归因到具体沙箱 |
| 模板变更不追溯 | 已预热的 Pod 继续执行旧策略，要滚动更新 Pool 才生效 |
| 运行时 patch 需要预置 token | 分配后仍可动态改策略（SDK 走 server 鉴权），但模板必须先带 token |

> sandbox_id 归因缺失是我认为池化模式目前最实际的短板：一个 Pool 服务多个租户时，deny webhook 只知道"有沙箱撞了黑名单"，不知道是谁。审计闭环断了。

## 池化出口 + Higress：粗粒度给 sidecar，细粒度给网关
------
> 这是我自己方案里最想展开的部分。egress 的能力边界卡在两个地方：没有端口维度、没有 L7。企业内网场景（内部 HTTP API、NodePort 服务）恰好需要这两样。既然集群里已有 Higress 网关，与其改造 egress，不如分层。

先固化平台级基线。`/var/egress/rules/deny.always`（优先级高于用户策略，每分钟热加载，用户不可覆盖）：

```text
# 平台组件 Service DNS
opensandbox-server.opensandbox.svc.cluster.local
opensandbox-ingress-gateway.opensandbox.svc.cluster.local
# 集群内部 CIDR：平台组件 + 沙箱间互访一刀切
10.244.0.0/16    # Pod CIDR
10.96.0.0/12     # Service CIDR
# 上层业务运行时
10.40.0.0/16
*.admin.corp
```

用户策略（Pool 模板）只放外部服务和网关：

```json
{
  "defaultAction": "deny",
  "egress": [
    {"action": "allow", "target": "api.openai.com"},
    {"action": "allow", "target": "*.pypi.org"},
    {"action": "allow", "target": "higress-gateway.corp.internal"},
    {"action": "allow", "target": "10.20.0.0/16"}
  ]
}
```

分层架构：

```
沙箱应用容器
   │
   ▼
egress sidecar（dns+nft，defaultAction: deny）
   │  只放行：外部服务域名 + Higress 网关
   ├──────────────► 外部服务（LLM / GitHub / 包源）——域名直连
   │
   ▼
Higress 网关（L7：路径级 allow/deny、认证、限流）
   │
   ▼
内部服务（HTTP API / NodePort 服务）
```

分工：

| 层 | 职责 | 粒度 |
|---|---|---|
| egress | 默认拒绝 + 白名单；强制内部流量必须走网关；隔离平台组件/业务运行时 | 域名 / IP / CIDR |
| Higress | 路径/方法级 allow/deny、认证、限流 | HTTP 路由 |

关键机制是**egress 把集群内部 CIDR 全 deny，只放行网关**——沙箱想访问内部服务，物理上只有 Higress 一条路。这样 L7 管控点天然收口到网关，Higress 上配路由级策略就够，不用关心流量从哪个沙箱来。这个思路对做网关的人来说很自然：L3/L4 收口是防火墙的活，L7 治理是 API 网关的活，别让一个组件干两层的事。

落地时有三个必须踩准的点：

**一，内部 Service 要双重放行。** 访问集群内 Service，域名（过 DNS 层）和 ClusterIP CIDR（过 nft 层）必须**同时** allow。只放域名会出现最迷惑的现象：`nslookup` 正常，TCP 连接超时——nft 把包丢了，而且动态放行失败在沙箱内看和策略拒绝不可区分。

**二，通配符不匹配裸域。** `*.pypi.org` 匹配不到 `pypi.org` 本身（`domain_index.go` 里 exact map 和 wildcard suffix map 是分开的），要两条都加。

**三，NodePort 看场景。** 专用节点池就 allow 节点网段（如 `10.30.1.0/24`）；共享节点无法按端口区分，必须让服务走 Higress（网关以 NodePort 暴露，egress 只放网关节点 IP），或者改 ClusterIP + 网关转发。

验证不能只看策略文本，要实测行为：

```bash
osb egress get <sandbox-id> -o json   # 确认 mode=deny_all, enforcementMode=dns+nft
osb command run <sandbox-id> -o raw -- curl -I https://api.github.com   # 放行 → 200
osb command run <sandbox-id> -o raw -- curl -I https://blocked.corp     # 阻断 → NXDOMAIN
osb command run <sandbox-id> -o raw -- curl -I http://10.244.0.5        # 阻断 → 超时
```

注意 nft 链放行 `established,related`，改策略不掐存量连接——验证必须用新连接，不然测的是旧规则。

------
> 如果要在生产用这套组合，我会先补三件事：pool 模式的 sandbox_id 归因（比如 egress 支持分配时注入）、`egress.nftables.updates.failed_total` 指标的告警（动态放行失败是 fail-closed 静默故障，现象和策略拒绝一模一样）、以及一份按实际集群 CIDR 生成的 deny.always 模板——CIDR 写错要么误放行要么误阻断，且都很难从现象反推。

> 出口网络这条线到这里基本闭环了：组件内部实现 → 与 K8s 原生方案的取舍 → 池化 + 网关分层。整个 OpenSandbox 源码走读系列的下一篇也是收官篇，会把前面几篇没展开的踩坑合集一次性倒出来。

系列索引：[（一）CRD Controller 与 Reconcile 循环](/p/opensandbox-1-reconcile/) · [（二）Sandbox Lease 与生命周期管理](/p/opensandbox-2-lease/) · [（三）池化设计](/p/opensandbox-3-pool/)；下一篇（收官）：[踩坑合集](/p/opensandbox-5-pitfalls/)。
