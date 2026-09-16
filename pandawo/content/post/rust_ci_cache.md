---
title: "记一次 Rust CI 缓存排查"
slug: rust-ci-cache
date: 2026-09-16T22:53:36+08:00
lastmod: 2026-09-16T22:53:36+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories:
    - 技术笔记
    - rust
tags:
    - rust
    - ci
    - github-actions
image: https://picsum.photos/seed/79c63ec4/800/600
---
# 记一次 Rust CI 缓存排查
------
> fork 的 grok-build-proxy 打 v1.0.27 tag，Windows release 跑了 57 分钟，Linux 同一次只要 9 分钟。日志里 rust-cache 显示命中，中途换上的 sccache 也"正常工作"，最后扫出来 5229 条缓存碎片把 10 GB 配额挤爆了。这篇把整条排查链路记下来：两次误判、实测数字、最后的方案。

## 背景
------
上游 grok-build 的 CI 跑在内部 runner 上，带 DotSlash 工具链和内部 secrets，fork 用不了，所以自己加了两份工作流：

- `build.yml`：push main / PR 触发。Linux 跑 fork 动过的 crate 的测试，Windows 只 check + 可移植测试
- `release.yml`：推 `v*` tag 触发。构建 grok CLI 二进制，出 linux-amd64 / windows-amd64 两个包，附 sha256

工作区大约 100 个 crate，Windows 冷编 release 依赖树实测约 50 分钟，Linux 同一次 9 分钟。瓶颈一直在 Windows。另外 `bin/protoc` 是 DotSlash 占位脚本，CI 上得自己装 protoc 31.1——Chocolatey 源给过一次 504 却退出码 0，后面才报 `protoc not found`，于是改成 GitHub release 直下。

## 时间线
------
| 提交 | 做了什么 |
|---|---|
| `f5ad7a5` | 搭 build / release。两边 job 都叫 `linux` / `windows` |
| `7a6d298` | 发现 release 命中了 build 的 debug `target/`，改接 sccache + GHA 后端 |
| `fd81836` | 踩坑：cargo 的 profile 环境变量只认 `"true"`/`"false"`，写 `0`/`1` 不生效 |
| `7988433` | 把 sccache 服务端错误打到日志 |
| `bc2c8ea` | Windows protoc 从 choco 换成 pinned zip |
| `abc2766` | 关 Defender、最终链接换 `rust-lld`、钉死 1.94.0、加 sccache 命中率断言 |
| `8c99e92` | tag 构建注入 `GROK_VERSION`，否则二进制版本号回落到过期的 Cargo.toml |
| `db865e4` | 拆掉 sccache GHA 后端，rust-cache 用 `shared-key` 隔开 build / release |

`abc2766` 里的 Defender / rust-lld / 1.94.0 / `GROK_VERSION` 都留着，最后只是把 sccache 那一层拿掉。

## 第一次误判：job 名撞车
------
[Swatinem/rust-cache](https://github.com/Swatinem/rust-cache/blob/master/README.md) 的 key 默认拼上 job 名（实现在 [src/config.ts](https://github.com/Swatinem/rust-cache/blob/master/src/config.ts)：没有 `shared-key` 时取 `GITHUB_JOB`，再加 `os.type()` / `os.arch()`）。我两个工作流的 job 都叫 `linux` 和 `windows`，lockfile 和 toolchain 又一样，于是 release 把 build 刚存的 debug `target/` 整包还原了回来。

cargo 看 fingerprint，debug 产物对 `--release` 一点忙帮不上。Windows 每次打 tag 都把依赖树重编一遍，日志上 rust-cache 显示 hit，实际零收益。

当时的对策写在 `7a6d298`：sccache 按编译单元内容寻址，debug/release 不该互相污染；rust-cache 只留 `~/.cargo` 注册表（`cache-targets: false`），省点配额；再加 `workflow_dispatch` 在打 tag 前预热。

这个诊断（job 名撞车）是对的，选的药不对。

## 第二次误判：sccache 的 GHA 后端
------
mozilla/sccache 接 GitHub Actions cache 时，**每个编译单元单独写一条 cache**，不是 `@actions/cache` 那种一个 key 一个 tar。原文在 [PR #1528](https://github.com/mozilla/sccache/pull/1528) 写进过文档：

> In contrast to the `@actions/cache` action, which saves a single large archive per cache key, `sccache` with GHA cache storage saves each cache entry separately.

维护者后来把这段从 `GHA.md` 里挪走了，行为没变：[issue #1762](https://github.com/mozilla/sccache/issues/1762)（2023 年开到现在）写的就是这事。2026-09-16 中午我在本仓库扫了一下：

```bash
gh api --paginate /repos/daidaiJ/grok-build-proxy/actions/caches
```

| | 条数 | 体积 |
|---|---|---|
| `sccache/<hash>` 碎片 | 5229 | 6090.6 MiB |
| rust-cache（linux/windows 混着 debug 残留） | 5 | 约 4.5 GiB |
| 合计 | 5234 | 10.6 GiB |

[GitHub 文档](https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows#usage-limits-and-eviction-policy)说每个仓库缓存默认 10 GB，7 天未访问删除；超限后新条目照存，按**上次访问时间从旧到新**逐出。debug 构建天天跑、碎片天天写，release 那批对象访问得少，最先被挤掉。这就成了个死循环：

```mermaid
flowchart LR
    A[debug build 天天跑] --> B[每天写几千条 sccache 碎片]
    B --> C[10 GB 配额打满]
    C --> D[release 的缓存被逐出]
    D --> E[release 冷编 57 分钟]
    E -- 往满缓存里继续写 --> B
```

再补一刀：sccache 的 Rust hash 吃 rustc 可执行文件路径、host triple、sysroot、**解析后的 rustc 参数**（见 [docs/Caching.md](https://github.com/mozilla/sccache/blob/main/docs/Caching.md)）。`--release` 和 dev 的 opt-level、codegen-units、debuginfo 全不同，debug 跑出来的缓存对 release 命中率就是 0。两个工作流在抢同一份 10 GB，彼此帮不上。

顺带一个 cargo 的坑（`fd81836`）：`CARGO_PROFILE_<name>_INCREMENTAL` 这类 profile 环境变量是 boolean，只认 `"true"`/`"false"`，写成 `0`/`1` 静默不生效。

## 实测数字
------
**release `35078943587`（tag v1.0.27）**

- Linux：约 9 分钟
- Windows：约 57 分钟
- Windows sccache：1264 次请求，executed 1079，**hits 0，misses 1074，命中率 0.00%**，平均 cache write 0.437 s

0.437 s × 1074 ≈ 8 分钟，纯浪费在往已经满了的 GHA 缓存里写碎片。

**build `35076697980`（main，同一天早些）**

- Linux：约 14 分钟，sccache 399 hit / 4 miss，**99.01%**
- Windows：约 6 分钟（只 check + 三个可移植 crate 的 test）

Linux debug 的 99% 是真的：同一 profile、频繁跑、碎片还在。但正是这个 99% 掩盖了 release 完全 miss 这件事。

更早一次 Windows tag 构建更离谱：cargo 编了 991 个 crate，sccache 服务端只看到 4 次请求，内存里的 stats 还报 "100% - 3 hits"——服务在构建中途重置过。所以 `abc2766` 加了个断言：sccache 请求数低于 cargo `Compiling` 行数的 90% 就 fail。这是在 sccache 已经不可信之后打的补丁，治标。

## 大项目都怎么做
------
查了一圈活跃 Rust 项目的 CI（2026-09-16）：

| 项目 | 做法 |
|---|---|
| [Helix](https://github.com/helix-editor/helix/blob/master/.github/actions/rust-setup/action.yml) | 复合 action：rust-toolchain + rust-cache，`shared-key` 隔离；release dist job 不缓存 `target/` |
| [clap](https://github.com/clap-rs/clap/blob/master/.github/workflows/ci.yml) | rust-cache + `CARGO_INCREMENTAL=0`，无 sccache |
| [starship](https://github.com/starship/starship/blob/master/.github/workflows/workflow.yml) | rust-cache + `CARGO_INCREMENTAL=0`、`CARGO_NET_RETRY=10` |
| [Tauri](https://github.com/tauri-apps/tauri/blob/dev/.github/workflows/lint-rust.yml) | rust-cache，key 带 target triple |
| [Polars](https://github.com/pola-rs/polars/blob/main/.github/workflows/test-python.yml) | rust-cache，`save-if` 只在 push 上写，PR 只读 |
| [rust-analyzer](https://github.com/rust-lang/rust-analyzer/blob/master/.github/workflows/ci.yaml) | `CARGO_INCREMENTAL=0`，rust-cache 整段注释掉了 |

结论很一致：没有人在 CI 上用 sccache 的 GHA 后端。[Depot 的评测](https://www.depot.dev/blog/sccache-in-github-actions)和 [Linera 的事故单](https://github.com/linera-io/linera-protocol/issues/5475)是同一句话——把 GHA 当 CAS 用，还是那 10 GB 和分支隔离，每个 rustc 调用还要打一次 cache API；真要跨 job 共享编译单元得上 S3/R2。

> 对我这个 fork：没有 S3，工作区大，release 不频繁。正确做法就是每 OS、每 profile 一块 rust-cache，总量压进 10 GB。

顺带查了 Defender：GitHub 官方 Windows runner 的[镜像构建脚本](https://github.com/actions/runner-images/blob/main/images/windows/scripts/build/Configure-WindowsDefender.ps1)本身就写了 `DisableRealtimeMonitoring = $true`。但镜像里关过不代表 job 运行时还关着（Tamper Protection 会让部分 `Set-MpPreference` 静默失败），所以 release job 仍显式调一次。这个规模的构建，ci-setup 的注释里记的量级是 1.3–2x 的 rustc spawn / 对象文件写入开销。

## 最终方案
------
`db865e4` 把工具链和缓存收进一个 composite action `.github/actions/ci-setup`，rust-cache 部分：

```yaml
- uses: Swatinem/rust-cache@v2
  with:
    prefix-key: v1-rust                      # 丢掉旧的 v0-rust 混装包
    shared-key: ${{ inputs.cache-scope }}    # build / release，不再用撞车的 job 名
    cache-targets: true                      # release 重新存 target/release
    cache-on-failure: true                   # 测试挂了编译结果还在
    save-if: ${{ github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/') }}
```

两个工作流统一：`CARGO_INCREMENTAL=0`、`CARGO_NET_RETRY=10`、concurrency 取消同 ref 旧 run。Windows release 仍用 `rust-lld`（`link.exe` 单最终链接就花了约 12 分钟），tag 构建仍注入 `GROK_VERSION`。

sccache 碎片清掉之后的配额估算：

| blob | 大约 |
|---|---|
| linux-build `target/` | 2.8 GB（已测） |
| windows-build | 0.8 GB（已测） |
| linux-release | 1.5–2 GB |
| windows-release | 1.5–2 GB |
| 合计 | 约 7–8 GB，进得去 10 GB |

打 tag 前用 `workflow_dispatch` 预热，它走同一套 `--release` 构建但不上传 Release：

```bash
gh workflow run release.yml --ref main
gh run watch
```

第一次跑会冷，存盘之后同 lockfile 的下一次 tag 只重编改过的 crate。

## 没修完的
------
- `session::workflow::manager::tests::cancel_drops_queued_spawns_before_coordinator` 在 Linux CI 上死锁过一次，把 job 空转了 37 分钟被 60 分钟 timeout 收掉。现在只靠 20 分钟 step timeout 止损，测试本身没改。
- `gh cache delete --all` 清 5000+ 条 `sccache/` 碎片还在后台跑，配额要等删完才真正腾出来。
- workspace crate 默认不在 rust-cache 里（[README](https://github.com/Swatinem/rust-cache/blob/master/README.md) 写 "generally not effective"：checkout 会把源码 mtime 刷成 now，cargo 当它变了就重编）。贵的是 crates.io 依赖，那些留下来了。Helix 那种 `git-restore-mtime` 的做法没上。

> 这轮排查最花时间的不是改配置，是不信日志：rust-cache 显示 hit、sccache 显示 99%，都是真的，只是命中的对象不是你要的那个。得把 key 怎么组成、还原回来的是什么、往配额里写了什么拆开看，数字才对得上。
