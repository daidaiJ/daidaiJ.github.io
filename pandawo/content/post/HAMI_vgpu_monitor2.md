---
title: "HAMI vgpu monitor 解析：（二）"
slug: "vGPU"
description: "HAMI vgpu原理解析笔记"
date: 2026-01-09T18:14:42+08:00
lastmod: 2026-01-09T18:14:42+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["vgpu"]
tags: ["golang","python"]
image: https://picsum.photos/seed/478a975b/800/600
---
# 从HAMi vGPU Monitor 排错开始
> 近期项目中hami vgpu monitor 的vgpu 利用率一直获取为0，但是节点上的物理卡nvidia-smi 利用率为100% 附近，两者显然是冲突的，下面是排查的过程，包括一些工具脚本的开发

## 解析cache 文件
从上一篇指定vgpu monitor 获取的数据源是一个mmap 创建的内存映射cache文件，我们从hami pkg monitor 中截取一部分代码，用来作为一个hami cache 文件解析的工具，代码主要如下
```go
//go:build linux
// +build linux

package main

import (
	"flag"
	"fmt"
	v1 "hami_tool/v1"
	"os"
	"syscall"
)

type UsageInfo v1.Spec

type ContainerUsage struct {
	PodUID        string
	ContainerName string
	data          []byte
	Info          v1.Spec
}

func readCacheFile(cacheFile string) (*ContainerUsage, error) {
	// 1. 打开文件（只读模式）
	f, err := os.OpenFile(cacheFile, os.O_RDONLY, 0666)
	if err != nil {
		return nil, fmt.Errorf("打开缓存文件失败: %w", err)
	}
	defer func() {
		_ = f.Close()
		fmt.Printf("已关闭文件：%s\n", cacheFile)
	}()

	// 2. 获取文件信息（大小）
	info, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("获取文件信息失败: %w", err)
	}
	fileSize := info.Size()
	if fileSize == 0 {
		return nil, fmt.Errorf("缓存文件为空：%s", cacheFile)
	}
	fmt.Printf("缓存文件大小：%d 字节\n", fileSize)

	// 3. mmap映射文件（仅读取）
	mmapData, err := syscall.Mmap(
		int(f.Fd()),
		0,
		int(fileSize),
		syscall.PROT_READ,
		syscall.MAP_SHARED,
	)
	if err != nil {
		return nil, fmt.Errorf("mmap映射文件失败: %w", err)
	}
	// 确保mmap内存最终会释放（无论解析是否成功）
	defer func() {
		if err := syscall.Munmap(mmapData); err != nil {
			fmt.Printf("释放mmap内存失败: %v\n", err)
		} else {
			fmt.Printf("已释放mmap内存，长度：%d\n", len(mmapData))
		}
	}()

	// 4. 深拷贝mmap数据到新的字节切片（核心修改）
	dataCopy := make([]byte, len(mmapData))
	copy(dataCopy, mmapData) // 将mmap内存的数据复制到新内存

	// 5. 用拷贝后的数据解析（此时解析结果不再依赖mmap内存）
	fmt.Printf("casting......v1\n")
	usage := &ContainerUsage{}
	usage.Info = v1.CastSpec(dataCopy)

	// 6. 返回解析结果（仅保留Info，mmap内存会在defer中释放）
	return usage, nil
}

func main() {
	// 1. 解析命令行参数
	var cacheFile string
	flag.StringVar(&cacheFile, "f", "", "缓存文件路径（必填）")
	flag.Parse()

	// 2. 校验参数
	if cacheFile == "" {
		fmt.Printf("必须通过 -f 参数指定缓存文件路径")
		flag.Usage() // 打印用法
		os.Exit(1)
	}

	// 3. 核心逻辑：一次性读取并解析mmap文件
	usage, err := readCacheFile(cacheFile)
	if err != nil {
		fmt.Printf("处理缓存文件失败: %v", err)
		os.Exit(1)
	}
	for i, proc := range usage.Info.GetProcs() {
		fmt.Printf(" %d proc hostpid [%d] pid [%d] util [%d] mem [%d]", i, proc.GetHostPid(), proc.GetPid(), proc.GetUtil(), proc.GetMemUtil())

	}

}

```
v1 的核心定义如下，基本上是nvidia v1 里面spec 定义稍微修改了点
```go

package v1

import "unsafe"

const maxDevices = 16

type deviceMemory struct {
	contextSize uint64
	moduleSize  uint64
	bufferSize  uint64
	offset      uint64
	total       uint64
	unused      [3]uint64
}

type deviceUtilization struct {
	decUtil uint64
	encUtil uint64
	smUtil  uint64
	unused  [3]uint64
}

type ShrregProcSlotT struct {
	pid         int32
	hostpid     int32
	used        [16]deviceMemory
	monitorused [16]uint64
	deviceUtil  [16]deviceUtilization
	status      int32
	unused      [3]uint64
}

func (s ShrregProcSlotT) GetHostPid() int32 {
	return s.hostpid
}

func (s ShrregProcSlotT) GetPid() int32 {
	return s.pid
}

func (s ShrregProcSlotT) GetMemUtil() uint64 {
	for _, val := range s.monitorused {
		if val > 0 {
			return val
		}
	}
	return 0
}

func (s ShrregProcSlotT) GetUtil() uint64 {
	for _, device := range s.deviceUtil {
		if device.smUtil > 0 {
			return device.smUtil
		}
	}
	return 0
}

type uuid struct {
	uuid [96]byte
}

type semT struct {
	sem [32]byte
}

type SharedRegionT struct {
	initializedFlag int32
	majorVersion    int32
	minorVersion    int32
	smInitFlag      int32
	ownerPid        uint32
	sem             semT
	num             uint64
	uuids           [16]uuid

	limit   [16]uint64
	smLimit [16]uint64
	procs   [1024]ShrregProcSlotT

	procnum           int32
	utilizationSwitch int32
	recentKernel      int32
	priority          int32
	lastKernelTime    int64
	unused            [4]uint64
}

type Spec struct {
	sr *SharedRegionT
}



func CastSpec(data []byte) Spec {
	return Spec{
		sr: (*SharedRegionT)(unsafe.Pointer(&data[0])),
	}
}


func (s Spec) GetProcs() []ShrregProcSlotT {
	ret := []ShrregProcSlotT{}
	for _, proc := range s.sr.procs {
		if proc.hostpid != 0 && proc.pid != 0 {
			ret = append(ret, proc)
		}

	}
	return ret
}

```
这里我是手动确认了项目中cache 格式是符合v1 格式的，于是只做了v1 格式的解析工具
使用如下 `./hami_cache -f e38008ef-62e3-4400-8d87-dab22aaff197.cache` 后者就是从环境中拷贝出来的cache 文件  
![cache 文件解析结果](asset/hami_cache.png)  
目前可以确认cache 拿到的就是util 0 ，这时观察到hostpid 和pid 相等，怀疑是hostpid 到pid 映射失败，Hami core 只拿到容器内pid 的
接下来，需要在Hami 管理的容器中去尝试通过相同逻辑获取使用率，确认最终问题

## 容器内获取util demo
这里用的是nvidia-ml-py 这个nvml 的python 绑定，hami core 通过libvgpu.so 注入劫持了nvml 的直接调用，所以通过nvml 的python binding库搭配脚本，可以避开编译调试的复杂性，测试如下
```python

from contextlib import contextmanager
import time
import pynvml

@contextmanager
def _nvml():
    try:
        pynvml.nvmlInit()
        yield
    finally:
        pynvml.nvmlShutdown()

def gettimeofday_microsec():
    """
    纯Python实现：获取当前Unix微秒时间戳（向前偏移1秒）
    功能等价于原C代码+ctypes封装的逻辑，无任何C依赖
    """
    # 获取当前时间的秒数和微秒数（等价于C的gettimeofday）
    # time.time() 返回浮点数，单位为秒，精度到微秒级
    current_time = time.time()
    
    # 拆分出秒数和微秒数
    tv_sec = int(current_time)  # 整数部分：秒数
    tv_usec = int((current_time - tv_sec) * 1000000)  # 小数部分转微秒
    
    # 核心逻辑：向前偏移1秒（和原代码一致，避免秒数为0时出现负数）
    sec = tv_sec - 1 if tv_sec > 0 else 0
    
    # 计算最终的微秒级时间戳
    microsec = sec * 1000 * 1000 + tv_usec
    return microsec



@_nvml()
def debug():
    gpu_num:int=pynvml.nvmlDeviceGetCount()
    for i in range(gpu_num):
        handle = pynvml.nvmlDeviceGetHandleByIndex(i)
        procs = pynvml.nvmlDeviceGetComputeRunningProcesses(handle)
        for proc in procs:
            name = pynvml.nvmlSystemGetProcessName(proc.pid)
            memory = proc.usedGpuMemory // (1024**2)
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            microsec = gettimeofday_microsec()
            hami_sm_utils = pynvml.nvmlDeviceGetProcessUtilization(handle,microsec)
            print(f"pid {proc.pid} name {name} mem {memory} util {util.gpu}")    
            for hami_util in hami_sm_utils:
                sm_util = hami_util.sm_util
                print(f"hami pid {hami_util.pid} {sm_util}")
                    
                    
            
if __name__ == "__main__":
    debug()
```
这里主要是观察hami 通过pynvml.nvmlDeviceGetProcessUtilization 拿到的设备sm util 的过程来模拟其源码中定时获取监控数据的更新逻辑
```c
      // Get SM util for container
      int processes_num=0;
      nvmlDevice_t device;
      // 获取一秒间隔中的利用率采样数据
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
              proc->device_util[cudadev].sm_util = processes_sample[i].smUtil;
          }
        }
      }

```
运行结果如下  
![hami nvml 容器内执行结果](asset/hami_nvml.png)  
可以看到这中间的冲突是hostpid 在节点上是36103 和上一步拿到写在cache 中的hostpid 1082 完全不等，那这个猜想合理么？

## hami core 映射proc 和hostpid 的源码
```c
shrreg_proc_slot_t *find_proc_by_hostpid(int hostpid) {
    int i;
    for (i=0;i<region_info.shared_region->proc_num;i++) {
        if (region_info.shared_region->procs[i].hostpid == hostpid) 
            return &region_info.shared_region->procs[i];
    }
    return NULL;
}

```
可以看到就是凭借一个hostpid 相等来定位的，但是按照cache 中解析的那样，容器中hami core 错误将hostpid 和pid 弄成一个数了，目前还没想到好办法来解决，因为节点上会存在多卡情况，一个proc 可能存在多个卡上，用`nvmlDeviceGetUtilizationRates` 不能完全满足需求

