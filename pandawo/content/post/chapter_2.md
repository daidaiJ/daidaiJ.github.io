---
title: "分布式一致性hash golang 实现"
description: 
date: 2024-12-02T22:36:03+08:00
image: 
math: 
license: 
hidden: false
comments: true
musicid: 5264842
categories:
    - 分布式
    - demo
tags : 
    - golang
    - 分布式
---
# 分布式一致性哈希 Golang 实现





## 哈希环定义

```go
import "hash/crc32"
type Hash func(data []byte) uint32
// 用crc32 
var defaultHashFn = crc32.ChecksumIEEE
// 哈希环
// 注意，非线程安全，业务需要自行加锁
type HashRing struct {
    hash Hash
    // 每个真实节点的虚拟节点数量
    replicas int
    // 哈希环，按照节点哈希值排序
    ring []int
    // 用来在新增节点时去重的
    keys []string
    // 节点哈希值到真实节点字符串，哈希映射的逆过程
    nodes map[int]string
}

func NewHashRing(r int,fn Hash)*HashRing(){
    if fn==nil{
        fn = defaultHashFn
    }
    return &HashRing{
        replicas: r,
        hash: fn,
        ring: make([]int,0,8*r),
        keys: make([]string,0,8),
        nodes: make(map[int]string,8),
    }
    
}
```
## 方法实现
```go
import (
    "slices"
    "sort"
    "strconv"
)

func (h *HashRing) Add(nodes ...string) {
    for _, k := range nodes {

        exist := false
        for _, val := range h.keys {
            if val == k {
                exist = true
            }
        }
        if !exist {
            h.keys = append(h.keys, k)
            for i := 0; i < h.replicas; i++ {
                hash := int(h.hash([]byte(strconv.Itoa(i) + k)))
                h.ring = append(h.ring, hash)
                h.nodes[hash] = k
            }
        }
    }
    slices.Sort(h.ring)
}
func (h *HashRing) Len() int {
    return len(h.keys)
}

func (h *HashRing) Get(key string) string {
    if h.Len() == 0 {
        return ""
    }

    hash := int(h.hash([]byte(key)))

    // Binary search for appropriate replica.
    idx := sort.Search(len(h.ring), func(i int) bool { return h.ring[i] >= hash })

    // Means we have cycled back to the first replica.
    if idx == len(h.ring) {
        idx = 0
    }

    return h.nodes[h.ring[idx]]
}
func (h *HashRing)Rest(){
    h.ring = h.ring[:0]
    h.keys = h.keys[:0]
    clear(h.nodes)
}

```
- Add() 方法是用来创建节点环的,在一些节点退出后，可能需要reset 哈希环来再次重构哈希环
- Reset() 是用来重置hash环信息的
- Get()   就是用来获取 一致性哈希映射到的 节点的字符串上
