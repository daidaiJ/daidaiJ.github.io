---
title: "轻量服务器加固实践：五层防线与零新增组件"
slug: lightweight-server-hardening
date: 2026-10-25T11:33:10+08:00
lastmod: 2026-10-25T11:33:10+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories:
    - 技术笔记
tags:
    - linux
    - ssh
    - 安全
    - 性能优化
image: https://picsum.photos/seed/02bb8459/800/600
---
# 轻量服务器加固实践：五层防线与零新增组件
------
> 一台 2C2G 的腾讯云 Debian 13，公网开着 22 端口，定位是"只部署不构建"。两轮加固做下来，新增软件包数量是零，全部改动落在配置层和系统能力上。这篇记录完整的加固清单、几个选型判断，以及两处翻车。

![轻量服务器的五层防线](/images/hardening-practice/hero-layers.png)

## 先审计，再动手
------
> 加固前先搞清楚机器暴露了什么、跑了什么，不然就是在别人的清单上抄作业。

审计就这几条命令，十分钟出结果：

```bash
ss -tlnp                                           # 谁在监听
systemctl list-units --type=service --state=running
sshd -T | grep -E 'permitroot|password|maxauth'    # sshd 实际生效配置
nft list ruleset                                   # 防火墙现状
last -n 10 -F                                      # 谁登录过
apt list --upgradable                              # 有没有欠账的补丁
```

这台机器当时的状态：全机只有 sshd 的 22 在监听，fail2ban、chrony、unattended-upgrades 都在跑，OpenSSH 是 10.0p2，无待升级包。之前做过一轮 CIS 风格加固（sysctl、nftables、sshd drop-in），所以这次做的是增量，不是从零开始。

> 小机器的好消息是攻击面天然小：没有 web 应用、没有数据库、没有容器运行时，自动化扫描脚本最爱的 RCE 入口一个都没有。

## 入口层：nftables 默认 DROP
------

`/etc/nftables.conf` 的 input 链，策略默认拒绝，逐条放行：

```
table inet filter {
    chain input {
        type filter hook input priority filter; policy drop;

        iif lo accept
        ct state established,related accept
        ct state invalid drop

        # DHCP / DHCPv6 client: lease replies must be able to come back
        udp dport 68 accept
        udp dport 546 accept

        # ICMP / ICMPv6: path-MTU discovery, neighbour discovery, diagnostics
        ip protocol icmp accept
        ip6 nexthdr icmpv6 accept

        # SSH
        tcp dport 22 accept

        # LLM API distribution service (Go)
        tcp dport 8338 accept
    }
}
```

几个细节：

- `ct state established,related accept` 放最前面，回包不走后面整条规则链
- DHCP 的 68/546 必须放行，云主机靠它续租 IP
- ICMP 放行是为了 PMTU discovery 和邻居发现，全禁 ICMP 是老直觉，不是好实践
- 8338 是留给后续 API 服务的口，端口先放行，服务没上线前外面也摸不到东西
- fail2ban 的 f2b-table 是单独一张表，这份配置不碰它，reload 互不影响

云厂商的安全组是另一道免费防线——把 22 收紧到常用 IP 段，扫描脚本连握手的机会都没有，零主机成本。这道做在控制台上，不在机器里。

## 认证层：sshd 只认密钥
------

Debian 13 的 sshd 支持 drop-in，全部加固集中在 `/etc/ssh/sshd_config.d/99-hardening.conf`：

```
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
PermitEmptyPasswords no
AllowUsers root
MaxAuthTries 3
MaxSessions 4
MaxStartups 3:50:10
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no
AllowStreamLocalForwarding no
PermitUserEnvironment no
LogLevel VERBOSE
ClientAliveInterval 300
ClientAliveCountMax 3

# --- algorithm restriction: ssh-audit Debian 13 Server hardening guide ---
KexAlgorithms mlkem768x25519-sha256,sntrup761x25519-sha512,sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-gcm@openssh.com,aes128-ctr
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com
HostKeyAlgorithms sk-ssh-ed25519-cert-v01@openssh.com,ssh-ed25519-cert-v01@openssh.com,rsa-sha2-512-cert-v01@openssh.com,rsa-sha2-256-cert-v01@openssh.com,sk-ssh-ed25519@openssh.com,ssh-ed25519,rsa-sha2-512,rsa-sha2-256
PubkeyAcceptedAlgorithms sk-ssh-ed25519-cert-v01@openssh.com,ssh-ed25519-cert-v01@openssh.com,rsa-sha2-512-cert-v01@openssh.com,rsa-sha2-256-cert-v01@openssh.com,sk-ssh-ed25519@openssh.com,ssh-ed25519,rsa-sha2-512,rsa-sha2-256
RequiredRSASize 3072

# --- audit: log sftp file access (Mozilla OpenSSH guidelines) ---
Subsystem sftp /usr/lib/openssh/sftp-server -f AUTHPRIV -l INFO
```

几个关键选择：

- `AllowUsers root` 显式白名单，以后新增的账户默认进不来，要进再加
- `AuthenticationMethods publickey` 加 `PasswordAuthentication no`：撞库字典直接作废
- 算法白名单照 ssh-audit 的 Debian 13 指南抄，KEX 首选 mlkem768x25519（后量子混合）
- 转发类五连关：X11 / Agent / TCP / Tunnel / StreamLocal——机器只当部署目标，没有转发需求
- `MaxStartups 3:50:10` 很激进：3 个未认证连接就开始 50% 概率丢弃，10 个全丢。单管理员机器够用

## 防爆破：sshd 10.0 已经内置了一套
------

这次调研最大的意外：OpenSSH 9.8 起 PerSourcePenalties **默认开启**，官方定位就是"内置的 fail2ban 替代"。也就是说大多数跑着新 OpenSSH 的机器上，其实同时跑着两套防爆破，管理员自己不知道。

内置惩罚的默认值（`man 5 sshd_config`）：

| 触发条件 | 惩罚 |
|---|---|
| 认证失败后断开 | 5 秒 |
| LoginGraceTime 内没完成认证 | 10 秒 |
| 把 sshd 弄崩 | 90 秒 |
| 单源累计上限 | 10 分钟 |
| 起罚门槛（累计到才生效） | 15 秒 |

按 `PerSourceNetBlockSize 32:128` 逐 IP 追踪，不连坐 NAT 邻居；10.0 又加了 PerSourceMaxStartups 限制单源未认证并发。

fail2ban 留着做双轨：它封在 nftables 层，TCP 握手前就掐掉；sshd 内置惩罚在进程内生效，不依赖任何外部进程。配置薄到只有几行：

```
# /etc/fail2ban/jail.d/defaults-debian.conf
[DEFAULT]
banaction = nftables
banaction_allports = nftables[type=allports]

[sshd]
backend = systemd
journalmatch = _SYSTEMD_UNIT=ssh.service + _COMM=sshd
enabled = true

# /etc/fail2ban/jail.d/99-tune.conf
[sshd]
bantime = 1h
findtime = 30m
```

选型对比（2G 内存视角）：

| 方案 | 常驻内存 | 防线位置 | 结论 |
|---|---|---|---|
| OpenSSH 内置惩罚 | 0 | sshd 进程内 | 已默认开启 |
| fail2ban | 实测 31 MB | nftables 封禁集合 | 保留，纵深冗余 |
| sshguard | 约 2 MB（社区数据） | nftables | 够轻，但没有换的必要 |
| CrowdSec | 约 77 MB（官方论坛实测） | 社区情报联动 | 2G 机器不装 |

> 31 MB 买一道握手前的拦截，值；为省这 31 MB 去折腾组件替换，不值。

## 内核层：把提权原语直接砍掉
------

sysctl 集中在 `/etc/sysctl.d/`，加固一份、性能一份：

```
# /etc/sysctl.d/99-hardening.conf
kernel.kptr_restrict = 2
kernel.yama.ptrace_scope = 1
kernel.dmesg_restrict = 1
fs.suid_dumpable = 0
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_rfc1337 = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
kernel.kexec_load_disabled = 1
kernel.unprivileged_bpf_disabled = 2
```

```
# /etc/sysctl.d/98-network-perf.conf
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.tcp_slow_start_after_idle = 0
```

为什么是这几个：

- `unprivileged_bpf_disabled = 2`：BPF 利用链是内核提权常客，直接砍掉非特权 BPF
- `kexec_load_disabled = 1`：防运行时替换内核的攻击路径
- `kptr_restrict = 2` 加 `dmesg_restrict = 1`：砍掉内核地址泄露的观察面，提权 exploit 的第一步没了
- `protected_fifos/symlinks/hardlinks`：/tmp 里经典竞态的三件套
- `tcp_rfc1337 = 1`：TIME_WAIT assassination 防护
- BBR + fq：5M 小水管上服务 overseas 客户端，丢包环境下比 cubic 稳得多

`tcp_max_syn_backlog` 默认只有 128，和 somaxconn=4096 严重不匹配，对齐到 4096——服务没上线时是免费修正，上线后再踩就晚了。

## 资源优化：加固顺手做的
------

- journald 封顶 `SystemMaxUse=500M`（默认是文件系统的 10%，49G 盘上就是 4.9G）
- rsyslog 停用：journald 已经持久化，双写纯重复，省 5 MB 内存和一份磁盘写入，查日志统一 `journalctl`
- NOFILE：`/etc/security/limits.d/99-nofile.conf` 524288，systemd `DefaultLimitNOFILE=1048576`，部署上去的服务不用再调
- unattended-upgrades 补自动重启窗口：

```
// /etc/apt/apt.conf.d/52auto-reboot
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
```

部署型机器上没有常驻业务，内核更新即重启，不给旧内核留暴露窗口。以后有服务了记得把这个窗口纳入发布计划。

## 面向 agent 和脚本：为什么打不进来
------

"用 AI agent 加脚本打服务器"现在听着新鲜，拆开还是自动化的传统链路：扫描、撞库、已知漏洞利用、提权、持久化。每一层撞到的都是墙：

![自动化攻击链 vs 每层防线](/images/hardening-practice/attack-chain.png)

其中最硬的一道墙是"机器上没有编译器"。定位是只部署不构建，gcc、go、cargo、pip 一概没有——公开提权 exploit 大多是 C 源码或要装依赖的 Python 脚本，编译不了也装不了。一个为省资源做的决定，顺手成了防提权的护甲。

> 防线里最值得花钱的其实是"少装东西"。每个安全组件自己也是攻击面，也要吃内存。

未来 8338 的服务上线时，unit 里预埋 systemd 沙箱，服务就算被打穿也提不了权、出不了网，零额外进程：

```ini
[Service]
DynamicUser=yes
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=yes
CapabilityBoundingSet=
SystemCallFilter=@system-service
IPAddressAllow=10.0.0.0/8
MemoryMax=512M
```

## 踩坑记录
------

**坑一：agent 改不了 sshd 配置。** 这轮加固是 AI agent 通过 SSH MCP 做的，连接策略的 blacklist 拦了两类命令：passwd 类操作、往 sshd 配置写内容的重定向。拦得对——这正是"agent 失控或被提示注入后最危险的动作"两类。最后 `AllowStreamLocalForwarding no` 那一行留成手工命令，格式是改完先校验、通过才 reload：

```bash
grep -q '^AllowStreamLocalForwarding' /etc/ssh/sshd_config.d/99-hardening.conf \
  || echo 'AllowStreamLocalForwarding no' >> /etc/ssh/sshd_config.d/99-hardening.conf
sshd -t && systemctl reload ssh && echo OK
```

**坑二：sysctl 键名写错。** 把 `tcp_rfc1337` 写成了 `tcp_rfc1337_1`，内核 6.12 上不存在后者，`sysctl --system` 每次开机都要报一行错。更逗的是排错时 `grep -Ei 'error'` 被 `icmp_ignore_bogus_error_responses` 这个键名晃了一下——先看 stderr，再看 grep 命中。

**坑三：fq 要重启才挂上。** `default_qdisc` 只对新建的 qdisc 生效，eth0 上还挂着 fq_codel。但内核 4.13+ 的 BBR 自带内部 pacing，不依赖 fq，性能现在就是对的，下次重启自然切过去，不值得为这个动网卡。

> 加固做完的机器应该是什么样：常驻内存 383 Mi / 1.9 Gi，swap 一页没用过，监听端口还是只有 22。什么都没变慢，什么都没变重，只是外面的脚本进不来了。
