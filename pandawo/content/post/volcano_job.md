---
title: "Volcano调度器执行分布式任务记录"
slug: "volcano-ray-kubeflow"
description: "使用Volcano调度器执行分布式任务记录"
date: 2026-02-09T15:30:00+08:00
lastmod: 2026-02-09T15:30:00+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic:
categories: ["kubernetes","ai-ml"]
tags: ["volcano","ray","kubeflow","pytorch","distributed-computing"]
image: https://picsum.photos/seed/volcano-ray/800/600
---

# 使用Volcano调度器执行分布式任务记录实践记录

> 记录下如何使用Volcano调度器运行Ray分布式计算任务，以及使用Kubeflow Training Operator v1（老版本，限制v2 重构了）进行PyTorch模型训练的完整实践。

## Ray on Volcano 分布式计算示例

### 环境准备

在使用Ray on Volcano之前，需要确保：
- 已安装Volcano调度器的Kubernetes集群
- 启用Ray插件和svc插件

### Volcano Job配置

以下是一个完整的Ray集群部署配置：

```yaml
apiVersion: batch.volcano.sh/v1alpha1
kind: Job
metadata:
  name: ray-distributed-compute
spec:
  minAvailable: 3
  schedulerName: volcano
  plugins:
    ray: []    # 启用Ray插件
    svc: []    # 启用Service插件
  policies:
    - event: PodEvicted
      action: RestartJob
  queue: default
  tasks:
    - replicas: 1
      name: head
      template:
        spec:
          containers:
            - name: head
              image: rayproject/ray:2.9.0-py311-cpu
              command: ["bash", "-c"]
              args:
                - |
                  ray start --head --port=6379 && \
                  python3 /workspace/distributed_compute.py
              resources:
                requests:
                  memory: "4Gi"
                  cpu: "2"
                limits:
                  memory: "8Gi"
                  cpu: "4"
          restartPolicy: OnFailure
    - replicas: 2
      name: worker
      template:
        spec:
          containers:
            - name: worker
              image: rayproject/ray:2.9.0-py311-cpu
              command: ["bash", "-c"]
              args:
                - |
                  ray start --address=${RAY_HEAD_IP}:6379
              env:
                - name: RAY_HEAD_IP
                  value: "ray-distributed-compute-head-svc"
              resources:
                requests:
                  memory: "4Gi"
                  cpu: "2"
                limits:
                  memory: "8Gi"
                  cpu: "4"
          restartPolicy: OnFailure
```

### Ray分布式计算脚本

创建一个简单的分布式计算任务脚本：

```python
import ray
import time
import numpy as np

# 初始化Ray连接
ray.init(address="auto")

@ray.remote
def compute_task(data_chunk):
    """模拟计算密集型任务"""
    # 模拟一些计算
    result = np.sum(data_chunk ** 2)
    time.sleep(1)  # 模拟计算时间
    return result

def distributed_compute():
    """分布式计算示例"""
    print(f"Ray集群资源: {ray.cluster_resources()}")
    
    # 创建测试数据
    data_size = 1000000
    chunk_size = data_size // 4
    data_chunks = [np.random.random(chunk_size) for _ in range(4)]
    
    # 并行执行计算任务
    start_time = time.time()
    
    # 提交任务到Ray集群
    futures = [compute_task.remote(chunk) for chunk in data_chunks]
    
    # 获取结果
    results = ray.get(futures)
    
    total_result = sum(results)
    end_time = time.time()
    
    print(f"计算结果: {total_result}")
    print(f"总耗时: {end_time - start_time:.2f}秒")
    
    return total_result

if __name__ == "__main__":
    result = distributed_compute()
    print(f"分布式计算完成，结果: {result}")
```

### 部署和运行

下述操作可以通过业务代码来自动完成
```bash
# 应用Volcano Job配置
kubectl apply -f ray-distributed-compute.yaml

# 查看Pod状态
kubectl get pods

# 端口转发访问Ray Dashboard
kubectl port-forward service/ray-distributed-compute-head-svc 8265:8265

# 查看分布式计算日志
kubectl logs -f ray-distributed-compute-head-0
```

## Kubeflow Training Operator v1 PyTorch训练示例

### 环境准备

确保已安装Kubeflow Training Operator v1，并配置好GPU资源。

### ResNet训练脚本

一个简单的ResNet模型训练脚本：

```python
import torch
import torch.nn as nn
import torch.optim as optim
import torch.distributed as dist
import torch.multiprocessing as mp
from torch.nn.parallel import DistributedDataParallel as DDP
from torchvision import models, transforms
from torch.utils.data import DataLoader, TensorDataset
import os

def setup(rank, world_size):
    """初始化分布式训练环境"""
    os.environ['MASTER_ADDR'] = 'localhost'
    os.environ['MASTER_PORT'] = '12355'
    
    # 初始化进程组
    dist.init_process_group("nccl", rank=rank, world_size=world_size)

def cleanup():
    """清理分布式训练环境"""
    dist.destroy_process_group()

def create_dummy_dataset(size=1000):
    """创建虚拟数据集用于演示"""
    # 模拟ImageNet数据 (224x224 RGB图像)
    images = torch.randn(size, 3, 224, 224)
    labels = torch.randint(0, 1000, (size,))
    return TensorDataset(images, labels)

def train(rank, world_size, epochs=5):
    """训练函数"""
    print(f"Running DDP on rank {rank}.")
    setup(rank, world_size)
    
    # 设置设备
    torch.cuda.set_device(rank)
    device = torch.device(f"cuda:{rank}")
    
    # 创建模型
    model = models.resnet18(pretrained=False)
    model = model.to(device)
    ddp_model = DDP(model, device_ids=[rank])
    
    # 创建优化器和损失函数
    optimizer = optim.SGD(ddp_model.parameters(), lr=0.001, momentum=0.9)
    criterion = nn.CrossEntropyLoss()
    
    # 创建数据加载器
    dataset = create_dummy_dataset()
    sampler = torch.utils.data.distributed.DistributedSampler(
        dataset, num_replicas=world_size, rank=rank
    )
    dataloader = DataLoader(dataset, batch_size=32, sampler=sampler)
    
    # 训练循环
    ddp_model.train()
    for epoch in range(epochs):
        sampler.set_epoch(epoch)
        epoch_loss = 0.0
        
        for batch_idx, (data, target) in enumerate(dataloader):
            data, target = data.to(device), target.to(device)
            
            optimizer.zero_grad()
            output = ddp_model(data)
            loss = criterion(output, target)
            loss.backward()
            optimizer.step()
            
            epoch_loss += loss.item()
            
            if batch_idx % 10 == 0 and rank == 0:
                print(f"Epoch {epoch}, Batch {batch_idx}, Loss: {loss.item():.4f}")
        
        if rank == 0:
            avg_loss = epoch_loss / len(dataloader)
            print(f"Epoch {epoch} 完成，平均损失: {avg_loss:.4f}")
    
    cleanup()

def main():
    """主函数"""
    world_size = torch.cuda.device_count()
    print(f"使用 {world_size} 个GPU进行训练")
    
    mp.spawn(train, args=(world_size,), nprocs=world_size, join=True)

if __name__ == "__main__":
    main()
```

### PyTorchJob配置

创建Kubeflow PyTorchJob CR配置：

```yaml
apiVersion: kubeflow.org/v1
kind: PyTorchJob
metadata:
  name: resnet-training
  namespace: kubeflow
  annotations:
    sidecar.istio.io/inject: "false"
spec:
  cleanPodPolicy: None
  pytorchReplicaSpecs:
    Master:
      replicas: 1
      restartPolicy: OnFailure
      template:
        spec:
          containers:
          - name: pytorch
            image: pytorch/pytorch:2.0.1-cuda11.7-cudnn8-runtime
            command:
            - "python"
            - "/workspace/resnet_train.py"
            volumeMounts:
            - name: workspace
              mountPath: /workspace
            resources:
              requests:
                memory: "16Gi"
                cpu: "4"
                nvidia.com/gpu: 1
              limits:
                memory: "32Gi"
                cpu: "8"
                nvidia.com/gpu: 1
            ports:
            - containerPort: 23456
              name: pytorchjob-port
    Worker:
      replicas: 2
      restartPolicy: OnFailure
      template:
        spec:
          containers:
          - name: pytorch
            image: pytorch/pytorch:2.0.1-cuda11.7-cudnn8-runtime
            command:
            - "python"
            - "/workspace/resnet_train.py"
            volumeMounts:
            - name: workspace
              mountPath: /workspace
            resources:
              requests:
                memory: "16Gi"
                cpu: "4"
                nvidia.com/gpu: 1
              limits:
                memory: "32Gi"
                cpu: "8"
                nvidia.com/gpu: 1
            ports:
            - containerPort: 23456
              name: pytorchjob-port
          volumes:
          - name: workspace
            emptyDir: {}
```

### 部署和监控

```bash
# 创建PyTorchJob
kubectl create -f resnet-training.yaml

# 查看Job状态
kubectl get pytorchjobs resnet-training -n kubeflow

# 查看创建的Pod
kubectl get pods -l training.kubeflow.org/job-name=resnet-training -n kubeflow

# 查看训练日志（Master节点）
PODNAME=$(kubectl get pods -l training.kubeflow.org/job-name=resnet-training,training.kubeflow.org/replica-type=master,training.kubeflow.org/replica-index=0 -o name -n kubeflow)
kubectl logs -f ${PODNAME} -n kubeflow
```

## 总结

总结一下volcano 和 分布式计算运行时其实在业务中和常规k8s job定义的区别还是较少的，这上面两种常见的运行时的计算任务，其实很好转化为业务代码，通过api server 提交业务请求对应的cr 来触发volcano 调度器去创建分布式运行时对应的job 

1. **Ray on Volcano**：适合通用分布式计算任务，提供了灵活的编程模型和自动扩缩容能力
2. **Kubeflow Training Operator**：专为机器学习训练优化，提供了完整的训练作业管理功能

两种方案都可以充分利用Volcano的gang调度能力，确保作业的资源需求得到满足。在实际应用中，可以根据具体需求选择合适的方案。