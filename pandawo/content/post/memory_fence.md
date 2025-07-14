---
title: "Memory_fence"
slug: "memory_order"
description: "cpp 内存序和内存屏障"
date: 2025-07-06T15:19:34+08:00
lastmod: 2025-07-06T15:19:34+08:00
draft: false
toc: true
hidden: false
weight: false
qqmusic: 4966546
categories: ["并发","内存屏障","go gc"]
tags: ["cpp","go"]
image: https://picsum.photos/seed/91031763/800/600
---
# cpp 内存序
> cpp 的内存序在以往开发的经历中很少有相关的需求，因此也一直没去学，近期在交流群里面谈到这方面技术后，对相关的知识做一个串联，整理成此篇笔记；
## 内存屏障

说到cpp 的内存序，先不去罗列有几种内存序，首先[内存屏障](https://cppreference.cn/w/cpp/atomic/atomic_thread_fence)在cpp11 和c11 版本中就已经正式发布，其声明为 `extern "C" void atomic_thread_fence( std::memory_order order ) noexcept;` 下面是其三种内存屏障:
> 在 x86（包括 x86-64）上，atomic_thread_fence 函数不发出 CPU 指令，仅影响编译时代码移动，但 std::atomic_thread_fence(std::memory_order_seq_cst) 除外。
atomic_thread_fence 施加的同步约束比具有相同 std::memory_order 的原子存储操作更强。 虽然原子存储-释放操作阻止所有先前的读取和写入移动到存储-释放之后，但具有 std::memory_order_release 排序的 atomic_thread_fence 阻止所有先前的读取和写入移动到所有后续存储之后。

可以发现这三种内存屏障是约束编译时内存操作的顺序，然后解释释放和获取两种屏障，先具体到一个线程内，线程内的操作在插入释放屏障时，语义上应该在插入点之前执行的操作都应该在之前生效，不可被放到屏障之后去执行；获取屏障则是相反，是约束插入屏障后的操作不可以被提前执行，这个约束不是使用在单线程中的，因为单线程中使用最宽松的Relaxed 内存序，也就是能保证最终原子数据值的一致性就行。  
在多线程并发的场景中，如果使用原子量作为条件来约束多个线程之前的多个操作的条件，就需要注意这点，以免因为重排序，使得单个线程中语义上被原子量保证的内存操作，在跨线程的场景中被提前读到，或者延后写入。  
## 内存序
现在回到内存序上来，其表现上就是原子**读前写后**插入（release/acquire）两种相应的内存屏障，来保证跨线程的内存操作数据，是一种轻量级的同步机制，其中对应的开销更重的互斥锁的加解锁操作，内部本身就携带了内存屏障，内存序主要是用于多线程并发场景中的无锁并发数据结构，或者在高性能场景中避免直接加锁带来的性能瓶颈。

下面给出一个伪代码解释的两组内存序的使用场景，来帮助理解这个知识点：
1. memory_order_acquire/memory_order_release 读写内存序
```cpp
// 生产者线程（事务提交）
std::atomic<bool> transaction_complete(false);
void commit_transaction() {
    // 1. 写入事务数据到数据库
    write_data_to_database(...);
    // 2. 使用Release语义标记事务完成
    transaction_complete.store(true, std::memory_order_release);
}

// 消费者线程（读取事务结果）
void read_transaction() {
    // 1. 使用Acquire语义检查事务状态
    while (!transaction_complete.load(std::memory_order_acquire));
    // 2. 确保能看到事务提交前的所有写入
    read_data_from_database(...);
}
```
2. memory_order_acq_rel 读写同步内存序，这个会禁用读前写后的重排序
```cpp
std::atomic<int> connection_count(0);
std::mutex pool_mutex;

Connection* acquire_connection() {
    // 1. 使用AcqRel语义原子地增加连接计数
    int count = connection_count.fetch_add(1, std::memory_order_acq_rel);
    if (count < MAX_CONNECTIONS) {
        // 有可用连接，无需加锁
        return get_connection_from_pool();
    }
    // 无可用连接，加锁等待
    std::lock_guard<std::mutex> lock(pool_mutex);
    // ...
}

void release_connection(Connection* conn) {
    // 1. 使用AcqRel语义原子地减少连接计数
    connection_count.fetch_sub(1, std::memory_order_acq_rel);
    // 2. 将连接放回池中
    return_connection_to_pool(conn);
}
```

