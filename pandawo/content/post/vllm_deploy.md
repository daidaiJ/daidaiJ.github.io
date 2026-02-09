---
title: "Vllm deploy"
slug: "vllm"
description: "常见的vllm 部署llm 配置"
date: 2026-02-09T10:40:46+08:00
lastmod: 2026-02-09T10:40:46+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["ai"]
tags: ["python","llm"]
image: https://picsum.photos/seed/2d04c5e3/800/600
---

# vLLM 部署大模型手册
-----
以Qwen2.5-32B-Instruct 为例子  
基本命令：  
`python3 -m vllm.entrypoints.openai.api_server --trust-remote-code --enable-prefix-caching --disable-log-requests --model /data --gpu-memory-utilization 0.90 -tp 8 --port 8000 --served-model-name Qwen2.5-32B-Instruct --max-model-len 32768`
 
## vLLM常见参数配置说明
```txt
--model  挂载模型目录（与【挂载地址】保持一致）
-tp  卡数（部署模型需要几张卡就写几张）
--port 端口（默认8000即可）
--max-model-len 最大上下文长度
--served-model-name 模型名称
--gpu-memory-utilization 0.90
--max_num_seqs batch 里面的最大输入序列个数
--enforce_eager 禁用图捕获优化参数，能节省一些显存
--pipeline_parallel_size 一般是多节点部署时，按照这个参数去拆分模型层，多个节点构成流水线，但是会增加延迟 
--max_num_batched_tokens = batch_size * max_model_len， 是一个batch 中总的token 数
--enable_expert_parallel 对部分MOE 专家模型，启用专家并行
--kv-transfer-config '{"kv_connector":"MooncakeConnector","kv_role":"kv_consumer"}' 安装mooncake-transfer-engine 可以通过多级缓存和RDMA 来加速kv cache 传输，优化推理
-dcp  这个计算公式是 tp数/（kv 头数*节点数） ，可以保持同个节点上不会重复载入
注：预估 tp 的值（卡数），简单预算公式（单位GB）：模型文件总大小 * 1.2 <= GPU显存大小
```
## 多节点部署
### mp 运行时
```shell
# master 节点
python3 -m vllm.entrypoints.openai.api_server --trust-remote-code --enable-prefix-caching --disable-log-requests --model /data --gpu-memory-utilization 0.90 -tp 2 --port 8000 --served-model-name Qwen2.5-32B-Instruct # 注意下面这几行 
--nnodes 2  \
--node-rank 0  \ # 不同节点这个就这个rank 数不同，master 用0 
--master-addr 192.168.0.101 \
--distributed-executor-backend mp
```
### ray 计算后端
```shell
# 首先，先在master 节点
ray start --head --port=6379
# 然后其他worker 节点
ray start --address=${master_ip}:6379
# 这时候ray 集群通信就建立起来了
python3 -m vllm.entrypoints.openai.api_server --trust-remote-code --enable-prefix-caching --disable-log-requests --model /data --gpu-memory-utilization 0.90  --port 8000 -tp 8 --pipeline-parallel-size 2 --served-model-name Qwen2.5-32B-Instruct \ 
# 注意下面这个
--distributed-executor-backend ray

```
使用vllm 的示例脚本简化上述过程
```shell
# master
bash /vllm-workspace/examples/online_serving/multi-node-serving.sh leader --ray_cluster_size=2
python3 -m vllm.entrypoints.openai.api_server --trust-remote-code --enable-prefix-caching --disable-log-requests --model /data --gpu-memory-utilization 0.90  --port 8000 -tp 8 --pipeline-parallel-size 2 --served-model-name Qwen2.5-32B-Instruct 
# worker
bash /vllm-workspace/examples/online_serving/multi-node-serving.sh worker --ray_cluster_size=2
```
### Volcano 分布式任务编排
其实Volcano 本质上是对不同分布式任务运行时的编排调度管理工具，所以按照上面两种分布式运行时后端，创建job 时适配command 命令就行，volcano 会按照工作组做资源分配管理  
参照 [Volcano Kthena 在 Kubernetes 上部署多节点LLM推理](https://docs.vllm.ai/projects/ascend/zh-cn/v0.13.0/user_guide/deployment_guide/using_volcano_kthena.html)