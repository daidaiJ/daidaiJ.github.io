---
title: "HAMI vgpu monitor 解析：（一）"
slug: "vGPU"
description: "HAMI vgpu原理解析笔记"
date: 2026-01-08T11:23:12+08:00
lastmod: 2026-01-08T11:23:12+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["vgpu"]
tags: ["解析"]
image: https://picsum.photos/seed/dc637815/800/600
---
# HAMI vGPU Monitor 原理解析笔记

> hami 目前是一个很火的云原生基金会的开源项目，最早是第四范式推出的，通过动态库劫持来实现显存和核心切分  
 
## 监控整体架构
hami 的监控分成两个部分，一个是vgpu monitor ，通过在节点上按固定间隔从mmap cache 文件来跨进程获取device plugin 设备插件提供的监控数据，整个mmap 映射区域是按照自定义的二进制序列化协议来存取的，相当高效，在vgpu monitor 这边是提供了一个metrics 端点，可以从节点上直接curl 查看实时的metrics 数据，所以这部分逻辑还是相当简单的，主要是从设备插件那边获取动态的vgpu 使用率和显存使用量，所以重点还是分析设备插件这块
> nvidia-device-plugins 项目 https://github.com/Project-HAMi/HAMi-core.git

## 核心数据结构
```cpp
// CUDA_DEVICE_MAX_COUNT 表示一个节点上最多的卡数 16

// 使用率
typedef struct {
    uint64_t dec_util;
    uint64_t enc_util;
    uint64_t sm_util; // sm 核心使用率
    uint64_t unused[3];
} device_util_t;

// pod 监控信息结构
typedef struct {
    int32_t pid;
    int32_t hostpid;
    device_memory_t used[CUDA_DEVICE_MAX_COUNT]; // 显存分配信息，对监控没啥用，但是是实现共享显存的基础
    uint64_t monitorused[CUDA_DEVICE_MAX_COUNT]; // 显存用量字节
    device_util_t device_util[CUDA_DEVICE_MAX_COUNT]; // 存储sm 核心使用率
    int32_t status;   // GPU 状态
    uint64_t unused[3];
} shrreg_proc_slot_t;


typedef struct {
    int32_t initialized_flag;
    uint32_t major_version;
    uint32_t minor_version;
    int32_t sm_init_flag;
    size_t owner_pid;
    sem_t sem;
    uint64_t device_num;
    uuid uuids[CUDA_DEVICE_MAX_COUNT];
    uint64_t limit[CUDA_DEVICE_MAX_COUNT];
    uint64_t sm_limit[CUDA_DEVICE_MAX_COUNT];
    shrreg_proc_slot_t procs[SHARED_REGION_MAX_PROCESS_NUM];  //一个节点上最多支持的vgpu 负载1024个
    int proc_num;
    int utilization_switch;
    int recent_kernel;
    int priority;
    uint64_t last_kernel_time;
    uint64_t unused[4];
} shared_region_t;



```
## 初始化逻辑
```cpp
    // 跨进程共享的mmap 文件路径
    char* shr_reg_file = getenv(MULTIPROCESS_SHARED_REGION_CACHE_ENV);
    if (shr_reg_file == NULL) {
        shr_reg_file = MULTIPROCESS_SHARED_REGION_CACHE_DEFAULT;
    }

    int fd = open(shr_reg_file, O_RDWR | O_CREAT, 0666);
    if (fd == -1) {
        LOG_ERROR("Fail to open shrreg %s: errno=%d", shr_reg_file, errno);
    }
    region_info.fd = fd;
    // .. 做一些操作尝试写入，确保对象可写

    region_info.shared_region = (shared_region_t*) mmap(
        NULL, SHARED_REGION_SIZE_MAGIC, 
        PROT_WRITE | PROT_READ, MAP_SHARED, fd, 0);
```
这里的 SHARED_REGION_SIZE_MAGIC 其实就是预定义的shared_region_t 字节数
核心结构是shrreg_proc_slot_t ，申请共享内存时，一个节点上最多16张卡，最多1024 个任务负载，这些负载需要记录节点上的多卡vgpu 监控数据所以需要有16 个device_util 和monitorused ， 另一个device_memory_t 是在不同卡上的显存分配信息

## 核心获取逻辑
```cpp
int get_used_gpu_utilization(int *userutil,int *sysprocnum) {
    struct timeval cur;
    size_t microsec;

    int i;
    unsigned int infcount;
    nvmlProcessInfo_v1_t infos[SHARED_REGION_MAX_PROCESS_NUM];

    unsigned int nvmlCounts;
    CHECK_NVML_API(nvmlDeviceGetCount(&nvmlCounts));
    lock_shrreg();

    int devi,cudadev;
    for (devi=0;devi<nvmlCounts;devi++){
      uint64_t sum=0;
      infcount = SHARED_REGION_MAX_PROCESS_NUM;
      shrreg_proc_slot_t *proc;
      cudadev = nvml_to_cuda_map((unsigned int)(devi));
      if (cudadev<0)
        continue;
      userutil[cudadev] = 0;
      nvmlDevice_t device;
      CHECK_NVML_API(nvmlDeviceGetHandleByIndex(cudadev, &device));

      //Get Memory for container
      nvmlReturn_t res = nvmlDeviceGetComputeRunningProcesses(device,&infcount,infos);
      if (res == NVML_SUCCESS) {
        for (i=0; i<infcount; i++){
          proc = find_proc_by_hostpid(infos[i].pid);
          if (proc != NULL){
             // 这里是显存用量
              proc->monitorused[cudadev] = infos[i].usedGpuMemory;
          }
        }
      }
      // Get SM util for container
      gettimeofday(&cur,NULL);
      microsec = (cur.tv_sec - 1) * 1000UL * 1000UL + cur.tv_usec;
      nvmlProcessUtilizationSample_t processes_sample[SHARED_REGION_MAX_PROCESS_NUM];
      unsigned int processes_num = SHARED_REGION_MAX_PROCESS_NUM;
      res = nvmlDeviceGetProcessUtilization(device,processes_sample,&processes_num,microsec);
      if (res == NVML_SUCCESS) {
        for (i=0; i<processes_num; i++){
          proc = find_proc_by_hostpid(processes_sample[i].pid);
          if (proc != NULL){
              sum += processes_sample[i].smUtil;
              // 这里是sm 使用率
              proc->device_util[cudadev].sm_util = processes_sample[i].smUtil;
          }
        }
      }
      if (sum < 0)
        sum = 0;
      userutil[cudadev] = sum;
    }
    unlock_shrreg();
    return 0;
}

```
这里获取的时候也是直接按节点上的deviceidx 设备索引号来获取有负载的卡上的不同任务负载的显存用量和利用率数据