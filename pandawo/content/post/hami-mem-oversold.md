---
title: "HAMI 虚拟化原理与资源超卖机制"
slug: "oversold"
description: "HAMI vGPU 虚拟化原理笔记"
date: 2026-01-29T11:00:00+08:00
lastmod: 2026-01-29T11:00:00+08:00
draft: false
toc: true
hidden: false
weight: false
categories: ["vgpu"]
tags: ["golang","kubernetes"]
image: https://picsum.photos/seed/33b4728e/800/600
musicid: 5264842
---

# HAMI 虚拟化原理与资源超卖机制

> HAMI（HAMi）是一个开源的 vGPU 方案，本文从调度器原理、资源超卖两个方面做个总结。


## 一、调度器原理

### 1.1 架构概述

Hami-scheduler 采用 **Scheduler Extender** 机制实现，而非直接扩展 default-scheduler：

- 使用默认 `kube-scheduler` 镜像启动服务，通过配置将调度器名称指定为 `hami-scheduler`
- 为该调度器配置 Extender，Extender 服务由同一 Pod 中的另一个 Container 启动的 HTTP 服务提供

### 1.2 部署架构

```
Deployment (kube-system/vgpu-hami-scheduler)
├── Container 1: kube-scheduler（原生调度器）
│   └── 使用 KubeSchedulerConfiguration 配置 Extender
└── Container 2: vgpu-scheduler-extender（HAMi 调度逻辑）
    └── 提供 /filter 和 /bind HTTP 接口
```

### 1.3 关键配置

**KubeSchedulerConfiguration 配置：**

```yaml
profiles:
- schedulerName: hami-scheduler
extenders:
- urlPrefix: "https://127.0.0.1:443"
  filterVerb: filter      # 对应 /filter 接口
  bindVerb: bind          # 对应 /bind 接口
  nodeCacheCapable: true
  weight: 1
  httpTimeout: 30s
  enableHTTPS: true
  tlsConfig:
    insecure: true
  managedResources:
  - name: nvidia.com/vgpu
    ignoredByScheduler: true
  # ... 其他 vGPU 相关资源
```

**managedResources 作用：**
- 指定 HAMi 管理的资源类型（`nvidia.com/vgpu`、`nvidia.com/gpumem` 等）
- `ignoredByScheduler: true` 表示原生调度器忽略这些资源，完全由 Extender 处理
- 只有 Pod 申请了这些资源时，调度器才会请求 Extender

### 1.4 资源感知机制

#### 1.4.1 感知节点上的 GPU 资源信息

HAMi 通过 **Node Annotations** 获取 GPU 信息：

```yaml
# Node Annotation 示例
hami.io/node-nvidia-register: 'GPU-03f69c50-207a-2038-9b45-23cac89cb67d,10,46068,100,NVIDIA-NVIDIA A40,0,true:...'
```

格式解析：`GPU-ID,索引,显存(MB),核心数,厂商型号,NUMA节点,健康状态`

**数据来源：**
- DevicePlugin 中的后台 Goroutine 定时上报并写入 Node Annotations
- Scheduler 通过 `RegisterFromNodeAnnotations()` 方法定时（每 15 秒）从 Annotations 解析 GPU 信息

#### 1.4.2 感知节点上 GPU 使用情况

通过 **Informer 机制** Watch Pod 和 Node 变化：

```go
// Pod 事件处理
informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
    AddFunc:    s.onAddPod,
    UpdateFunc: s.onUpdatePod,
    DeleteFunc: s.onDelPod,
})
```

从 Pod Annotations 解析 GPU 使用情况：

```yaml
# Pod Annotation 示例
hami.io/vgpu-devices-allocated: 'GPU-03f69c50-207a-2038-9b45-23cac89cb67d,NVIDIA,3000,30:;'
```

格式解析：`GPU-UUID,设备类型,已用显存(MB),已用核心百分比`

### 1.5 调度核心算法

#### 1.5.1 Filter 接口（节点过滤与打分）

**流程：**
```
1. 检查 Pod 是否申请 vGPU 资源 → 未申请则返回全部节点
2. 获取所有节点的 GPU 使用情况 (getNodesUsage)
3. 计算每个节点的得分 (calcScore)
4. 选择得分最高的节点进行调度
```

**得分计算算法：**

```go
// pkg/scheduler/policy/node_policy.go
func (ns *NodeScore) ComputeScore(devices DeviceUsageList) {
    // 统计已使用资源
    used, usedCore, usedMem := int32(0), int32(0), int32(0)
    for _, device := range devices.DeviceLists {
        used += device.Device.Used
        usedCore += device.Device.Usedcores
        usedMem += device.Device.Usedmem
    }

    // 统计总资源
    total, totalCore, totalMem := int32(0), int32(0), int32(0)
    for _, deviceLists := range devices.DeviceLists {
        total += deviceLists.Device.Count
        totalCore += deviceLists.Device.Totalcore
        totalMem += deviceLists.Device.Totalmem
    }

    // 计算得分：资源使用率越高，得分越高
    useScore := float32(used) / float32(total)
    coreScore := float32(usedCore) / float32(totalCore)
    memScore := float32(usedMem) / float32(totalMem)

    ns.Score = float32(Weight) * (useScore + coreScore + memScore)
}
```

**核心逻辑：** 节点上 GPU Core 和 GPU Memory 资源剩余越少，得分越高（Binpack 策略）。

#### 1.5.2 Bind 接口（完成调度）

**核心逻辑：** 调用 Kubernetes API 创建 Binding 对象将 Pod 绑定到目标节点

```go
binding := &corev1.Binding{
    ObjectMeta: metav1.ObjectMeta{Name: args.PodName, UID: args.PodUID},
    Target:     corev1.ObjectReference{Kind: "Node", Name: args.Node},
}
err = s.kubeClient.CoreV1().Pods(args.PodNamespace).Bind(context.Background(), binding, ...)
```

### 1.6 内存数据结构

```go
type Scheduler struct {
    nodes map[string]*util.NodeInfo    // 节点 GPU 信息缓存
    cachedstatus map[string]*NodeUsage // 节点资源使用情况
    overviewstatus map[string]*NodeUsage // 全局节点概览
}
```

---

## 二、资源超卖机制

### 2.1 超卖配置参数

| 参数 | 默认值 | 超卖场景 |
|------|--------|----------|
| `device-memory-scaling` | 1.0 | 显存超卖（如设为 1.5 表示 100GB 可虚拟出 150GB） |
| `device-cores-scaling` | 1.0 | 核心超卖（如设为 1.5 表示 100% 核心可虚拟出 150%） |

### 2.2 资源充足情况

**场景：** 节点有足够的物理 GPU 资源满足 Pod 需求

**处理方式：**
1. 正常计算节点得分
2. 根据 Binpack 策略选择得分最高（资源利用率最高）的节点
3. Pod 分配到目标节点后，Device Plugin 进行资源绑定

**调度流程：**
```
Pod 申请资源 → Filter 阶段计算得分 → 选择得分最高节点 → Bind 阶段绑定 → Device Plugin 分配
```

### 2.3 资源不足情况

**场景：** 节点剩余资源无法完全满足 Pod 需求

**处理方式：**
| 场景 | 处理方式 |
|------|----------|
| **资源充足** | 正常计算得分，选择得分最高（资源利用率最高）的节点 |
| **资源不足** | `fitInDevices()` 判断节点剩余资源是否满足 Pod 需求，不满足则忽略该节点 |
| **所有节点都不满足** | 返回错误："no available node, all node scores do not meet" |

**核心判断逻辑（伪代码）：**
```go
func fitInDevices(node *NodeUsage, request ResourceRequest) bool {
    // 检查显存是否满足
    if node.AvailableMem < request.Memory {
        return false
    }
    // 检查核心是否满足
    if node.AvailableCores < request.Cores {
        return false
    }
    // 检查设备数量是否满足
    if node.AvailableDevices < request.DeviceCount {
        return false
    }
    return true
}
```

### 2.4 显存超卖原理

当 `device-memory-scaling > 1.0` 时启用显存超卖：

1. **注册阶段**：将物理显存按比例放大写入 Node Annotations
   ```
   实际显存: 46068 MB
   缩放后显存: 46068 * 1.5 = 69102 MB
   ```

2. **调度阶段**：按虚拟显存进行调度，允许调度总量超过物理显存

3. **运行时限制**：通过 `libvgpu.so` 拦截 CUDA 内存分配请求
   - 环境变量 `CUDA_DEVICE_MEMORY_LIMIT_*` 设置显存上限
   - 超额部分通过共享缓存文件（`CUDA_DEVICE_MEMORY_SHARED_CACHE`）模拟

#### 2.4.1 运行时显存分配失败处理机制

当 Pod 在 limit 配额内申请更多显存，但整个 GPU 已经没有余下可用显存时，HAMi-core 通过以下机制处理，类似应用接收到显存分配失败异常，而不是被OOM Kill：

**1. 内存分配拦截与检查**

```c
// libvgpu/cuda_memory.c - cuMemAlloc_v2_hook
CUresult cuMemAlloc_v2_hook(CUdeviceptr *dptr, size_t bytesize)
{
    log_debug("Intercepted cuMemAlloc_v2: size=%zu", bytesize);

    // 检查内存限制
    if (check_memory_limit(bytesize) != 0) {
        log_error("Memory allocation exceeds limit: %zu bytes", bytesize);
        return CUDA_ERROR_OUT_OF_MEMORY;
    }

    // 调用真实的 cuMemAlloc
    CUresult result = cuMemAlloc_v2_real(dptr, bytesize);

    if (result == CUDA_SUCCESS) {
        // 更新内存使用统计
        update_memory_usage(bytesize);
        // 记录分配信息
        record_allocation(*dptr, bytesize);
    }

    return result;
}
```

**2. 共享内存协调机制**

HAMi-core 使用共享内存实现多进程间的内存使用统计和协调：

```c
// libvgpu/cuda_shm.c - 共享内存结构
struct shm_info {
    size_t memory_limit;      // 内存限制（来自环境变量）
    size_t used_memory;       // 当前已使用内存
    int process_count;        // 进程计数
    pid_t process_pids[MAX_PROCESSES];      // 进程PID数组
    size_t process_memory[MAX_PROCESSES];   // 每个进程的内存使用
};

// 检查内存限制
int check_memory_limit(size_t size)
{
    struct shm_info info;

    // 从共享内存获取当前内存使用情况
    if (get_shm_info(&info) != 0) {
        return -1;
    }

    // 检查是否超过限制
    if (info.used_memory + size > info.memory_limit) {
        log_error("Memory limit exceeded: %zu + %zu > %zu",
                  info.used_memory, size, info.memory_limit);
        return -1;
    }

    return 0;
}
```


**3. 处理流程总结**

```
┌─────────────────────────────────────────────────────────────────┐
│              显存分配失败处理流程                                 │
├─────────────────────────────────────────────────────────────────┤
│  1. CUDA 应用调用 cudaMalloc()                                   │
│     └── 被 libvgpu.so 拦截                                       │
│                                                                  │
│  2. 检查内存限制 (check_memory_limit)                           │
│     ├── 从共享内存读取当前使用量                                 │
│     ├── 检查是否超过 CUDA_DEVICE_MEMORY_LIMIT_*                 │
│     └── 如果超过，返回 CUDA_ERROR_OUT_OF_MEMORY                 │
│                                                                  │
│  3. 如果未超过限制，调用真实 cuMemAlloc()                       │
│     ├── 成功 → 更新共享内存使用统计                              │
│     └── 失败 → 返回 CUDA_ERROR_OUT_OF_MEMORY                    │
│                                                                  │
│  4. CUDA 错误处理                                                │
│     ├── 记录错误日志（当前使用量、限制值）                       │
│     ├── 触发 OOM 处理函数                                        │
│     └── 尝试清理缓存（如果有）                                   │
│                                                                  │
│  5. 应用程序收到 CUDA_ERROR_OUT_OF_MEMORY                       │
│     └── 应用程序自行处理 OOM（如释放内存、降低 batch size 等）   │
└─────────────────────────────────────────────────────────────────┘
```


### 2.5 核心超卖原理

当 `device-cores-scaling > 1.0` 时启用核心超卖：

1. **配置方式**：设置 `CUDA_DEVICE_SM_LIMIT` 环境变量限制 SM 使用比例
   ```
   物理核心: 100%
   缩放后虚拟核心: 150%
   ```

2. **实现原理**：通过 `libvgpu.so` 周期性采样和限制
   - 采样周期内如果 SM 利用率超过限制，则触发限流
   - `recentKernel` 和 `lastKernelTime` 用于平滑超卖场景下的资源分配

### 2.6 调度策略配置

**节点选择策略（通过 Annotations 配置）：**
- `hami.io/node-scheduler-policy`: 节点级调度策略（`binpack` / `spread`）
- `hami.io/gpu-scheduler-policy`: GPU 级调度策略（`binpack` / `spread`）

| 策略 | 说明 |
|------|------|
| **binpack** | 优先将 Pod 调度到资源使用率高的节点，减少碎片 |
| **spread** | 优先将 Pod 调度到资源使用率低的节点，提高容错 |

---

## 三、调度流程总结

```
┌─────────────────────────────────────────────────────────────────────┐
│                     HAMI 调度器工作流程                              │
├─────────────────────────────────────────────────────────────────────┤
│  1. 用户创建 Pod 并申请 vGPU 资源                                    │
│                                                                     │
│  2. Webhook 修改 SchedulerName 为 hami-scheduler                    │
│                                                                     │
│  3. hami-scheduler 接收调度请求                                      │
│     ├── 获取 Node Annotations → 解析 GPU 资源总量                   │
│     ├── 获取 Pod Annotations  → 解析 GPU 使用量                     │
│     └── 计算各节点剩余可用资源                                       │
│                                                                     │
│  4. Filter 阶段：                                                    │
│     ├── fitInDevices() 检查资源是否满足                             │
│     ├── 根据资源使用率计算得分（Binpack/Spread）                    │
│     └── 选择得分最高的节点                                          │
│                                                                     │
│  5. Bind 阶段：将 Pod 绑定到目标节点                                 │
│                                                                     │
│  6. Kubelet 启动 Pod，Device Plugin 进行资源绑定                    │
│     ├── 设置 NVIDIA_VISIBLE_DEVICES（原生逻辑）                    │
│     ├── 挂载 libvgpu.so，设置资源限制环境变量（HAMi 逻辑）          │
│     └── libvgpu.so 运行时拦截 CUDA API 实现资源隔离                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 四、关键环境变量汇总

| 环境变量 | 作用 |
|---------|------|
| `NVIDIA_VISIBLE_DEVICES` | 指定容器可见的 GPU 设备 |
| `CUDA_DEVICE_MEMORY_LIMIT_*` | 限制对应 GPU 的显存使用量 |
| `CUDA_DEVICE_SM_LIMIT` | 限制 GPU 核心（SM）使用比例 |
| `CUDA_DEVICE_MEMORY_SHARED_CACHE` | 共享内存缓存文件路径 |
| `CUDA_OVERSUBSCRIBE` | 启用显存超额订阅 |
| `CUDA_DISABLE_CONTROL` | 禁用 libvgpu.so 控制（跳过 ld.so.preload 替换） |
| `CoreLimitSwitch` | 是否关闭算力限制 |

---

## 五、总结

HAMI vGPU 方案的核心设计要点：

1. **调度器层**：采用 Extender 机制实现调度逻辑，根据节点资源使用率进行打分和选择

2. **资源超卖**：通过 `device-memory-scaling` 和 `device-cores-scaling` 参数启用，配合 `libvgpu.so` 实现运行时隔离

3. **核心隔离**：依赖 `libvgpu.so` 拦截 CUDA API，通过环境变量控制显存和核心使用上限
