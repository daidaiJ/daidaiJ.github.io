---
title: "Gpu test python script  "
slug: ""
description: ""
date: 2025-12-15T18:30:17+08:00
lastmod: 2025-12-15T18:30:17+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["tool"]
tags: ["python"]
image: https://picsum.photos/seed/ac2779a2/800/600
---

# gpu 测试脚本
> 因为项目背景需求，经常测试k8s pod 或者job 监控的gpu 显存，使用率相关指标，下面是一个工具脚本

## 脚本内容
```python

import argparse
import time
import random
import sys
import torch


def main():
    parser = argparse.ArgumentParser(description="gpu 负载测试脚本")
    parser.add_argument("--mem-gb", type=float, required=True, help="目标显存占用(GB)")
    # 为duration添加默认值60秒，不再强制必填
    parser.add_argument(
        "--duration", type=int, default=300, help="持续时间(秒)，默认300秒"
    )
    args = parser.parse_args()

    # 基础检查
    if not torch.cuda.is_available():
        raise RuntimeError("未检测到CUDA GPU")
    torch.cuda.empty_cache()
    device = torch.device("cuda")

    # 1. 精准计算张量形状（按字节级控制显存）
    dtype = torch.float32  # 固定float32，每元素4字节，简化逻辑
    elem_bytes = 4
    target_bytes = int(args.mem_gb * 1024 * 1024 * 1024)  # 目标显存转字节
    total_elems = target_bytes // elem_bytes
    # 生成2D张量形状（保证总元素数匹配目标显存）
    dim = int(total_elems**0.5)
    shape = (dim, dim)
    actual_mem_gb = (dim * dim * elem_bytes) / (1024**3)

    # 2. 分配张量（禁用梯度，无计算图，仅占显存）
    tensor = torch.randn(shape, dtype=dtype, device=device, requires_grad=False)
    # 校验显存占用
    allocated_mem_gb = torch.cuda.memory_allocated(device) / (1024**3)
    print(f"=== 初始化 ===")
    print(f"目标显存: {args.mem_gb}GB | 实际占用: {allocated_mem_gb:.4f}GB")
    print(f"张量形状: {shape} | 持续计算: {args.duration}秒\n")

    # 3. 核心：原地计算消耗GPU算力（无额外显存占用）
    start_time = time.time()
    try:
        while time.time() - start_time < args.duration:
            # 原地运算（所有操作均在原张量执行，不新增显存）
            tensor.add_(random.uniform(0.01, 0.1))  # 原地加
            tensor.mul_(random.uniform(0.9, 1.1))  # 原地乘
            tensor.sin_()  # 原地正弦
            tensor.cos_()  # 原地余弦
            torch.cuda.synchronize()  # 确保计算完成

            # 打印状态（覆盖式输出）
            elapsed = int(time.time() - start_time)
            remaining = max(0, args.duration - elapsed)
            print(
                f"剩余时间: {remaining:3d}秒 | 显存占用: {allocated_mem_gb:.4f}GB",
                end="\r",
            )
            time.sleep(0.001)  # 微调算力强度（越小算力越高）

    except KeyboardInterrupt:
        print("\n\n⚠️ 手动终止")
    finally:
        # ========== 核心：仅在退出时强制flush所有输出 ==========
        print("\n", flush=True)
        sys.stdout.flush()
        # 清理显存
        del tensor
        torch.cuda.empty_cache()
        final_mem = torch.cuda.memory_allocated(device) / (1024**3)
        print(f"\n=== 结束 ===")
        print(f"释放后显存: {final_mem:.4f}GB")


if __name__ == "__main__":
    main()


```
使用方式就是容器有pytorch 依赖，调用时如下:  
`python3 gpu_test.py --mem-gb 1` 来构造一个1GB 默认5分钟的gpu 计算任务 