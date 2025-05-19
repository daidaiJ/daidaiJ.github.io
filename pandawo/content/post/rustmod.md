---
title: "Rustmod"
slug: "rust_mod"
description: "一个便于快速理解的rust 项目组织示例"
date: 2025-05-19T17:09:22+08:00
lastmod: 2025-05-19T17:09:22+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
categories: ["rust","项目结构"]
tags: ["rust"]
image: https://picsum.photos/seed/52d60af3/800/600
---
# rust 项目组织
-----
## 项目结构
```txt
.
├── Cargo.toml
└── src
    ├── deno
    │   ├── data.rs
    │   └── hello.rs
    ├── deno.rs
    └── main.rs
```
## 主代码示例
首先声明`mod deno;` 表明从 `src/deno.rs` 中导入mod 定义 
```rust
mod deno;
use deno::hello;
use deno::get_data;
fn main() {
    hello("panda");
    print!("data: {}",get_data());
}

```
## 模块示例
这里先声明 `src/deno` 目录下的两个子模块，通过pub use 从当前模块中导出定义的两个函数
**deno.rs**
```rust
mod data;
mod hello;
pub use self::hello::hello;
pub use self::data::get_data;
```
**data.rs**
```rust
pub fn get_data()->&'static str{
    return "data";
}
```
**hello.rs**
```rust
pub fn hello(name:&str){
    println!("Hello ,{}",name);
}
```
## 备注
这里是一个最简单的mod 组织示例，用于快速回忆rust 的代码组织概念