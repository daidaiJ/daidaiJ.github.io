---
title: "使用python 实现一个分布式Singleflight"
slug: "singleflight with python"
description: "未上线的优化策略"
date: 2025-10-24T16:34:08+08:00
lastmod: 2025-10-24T16:34:08+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["python"]
tags: ["python"]
image: https://picsum.photos/seed/28cc2db5/800/600
---

# 使用Python 实现的分布式Singleflight
> 在golang 项目中Singleflight 是个常见的优化工具，但是在python 中好像没有标准库模块，用第三方的引入依赖也挺讨厌的，越来越重的依赖，所以这里仿照go 的机制，做了两个工具类，适合在fastapi 框架中使用，需要有redis 组件


## 同步版本多缓存实现
先看核心的类定义
```python

class DistributedSingleFlight:
    def __init__(self, redis: redis.Redis, local_cache: TTLCache):
        self.redis = redis
        self.local_cache = local_cache
        self.lock_prefix = "singleflight:lock:"
        self.result_prefix = "singleflight:result:"

    @contextmanager
    def _lock(self, key: str, timeout: int = 10):
        """分布式锁实现"""
        lock_key = f"{self.lock_prefix}{key}"
        identifier = str(uuid.uuid4())
        
        # 尝试获取锁
        acquired = self.redis.set(
            lock_key,
            identifier,
            nx=True,
            ex=timeout  # 防止死锁，自动过期
        )
        
        try:
            yield acquired, identifier
        finally:
            # 只有持有锁的进程才能释放锁
            if acquired:
                current = self.redis.get(lock_key)
                if current == identifier:
                    self.redis.delete(lock_key)

    def _get_result(self, key: str) -> Optional[Any]:
        """获取已缓存的结果"""
        result_key = f"{self.result_prefix}{key}"
        data = self.redis.get(result_key)
        if data:
            return json.loads(data)
        return None

    def _set_result(self, key: str, result: Any, ttl: int = 60):
        """缓存执行结果"""
        result_key = f"{self.result_prefix}{key}"
        self.redis.set(result_key, json.dumps(result), ex=ttl)
        # 同时更新本地缓存
        self.local_cache[key] = result

    def do(
        self,
        key: str,
        func: Callable,
        *args,
        result_ttl: int = 60,
        lock_timeout: int = 10,
        retry_interval: float = 0.1,
        **kwargs
    ) -> Any:
        """
        执行函数，跨进程确保同一 key 只有一个实例执行
        :param key: 任务标识
        :param func: 执行函数
        :param result_ttl: 结果缓存时间（秒）
        :param lock_timeout: 分布式锁超时时间（秒）
        :param retry_interval: 等待锁的重试间隔（秒）
        """
        # 先查本地缓存，减少 Redis 访问
        if key in self.local_cache:
            return self.local_cache[key]
        
        # 查 Redis 缓存
        cached_result = self._get_result(key)
        if cached_result is not None:
            self.local_cache[key] = cached_result
            return cached_result
        
        # 尝试获取分布式锁
        with self._lock(key, lock_timeout) as (acquired, identifier):
            if acquired:
                # 成功获取锁，执行实际任务
                try:
                    result = func(*args, **kwargs)
                    self._set_result(key, result, result_ttl)
                    return result
                except Exception as e:
                    # 可以选择缓存异常或直接抛出
                    raise e
            else:
                # 未获取到锁，等待结果
                while True:
                    result = self._get_result(key)
                    if result is not None:
                        self.local_cache[key] = result
                        return result
                    time.sleep(retry_interval)

    def wrap(
        self,
        key_func: Optional[Callable] = None,
        result_ttl: int = 60,
        lock_timeout: int = 10
    ) -> Callable:
        """装饰器版本"""
        def decorator(func: Callable) -> Callable:
            @wraps(func)
            def wrapper(*args, **kwargs) -> Any:
                # 生成 key
                if key_func:
                    key = key_func(*args, **kwargs)
                else:
                    key = f"{func.__module__}:{func.__name__}"
                return self.do(
                    key=key,
                    func=func,
                    *args,
                    result_ttl=result_ttl,
                    lock_timeout=lock_timeout,** kwargs
                )
            return wrapper
        return decorator

```
这里是测试用的主代码

```python
import time
import uuid
import json
from functools import wraps
from typing import Callable, Optional, Dict, Any
from contextlib import contextmanager

import redis
from cachetools import TTLCache
from fastapi import FastAPI
from singleflight import DistributedSingleFlight
# 初始化 Redis 连接（根据实际配置调整）
redis_client = redis.Redis(
    host="localhost",
    port=6379,
    db=0,
    decode_responses=True
)

# 进程内本地缓存（避免重复处理同一 key）
local_cache = TTLCache(maxsize=1024, ttl=60)  # 缓存 60 秒

app = FastAPI()




# 初始化单飞实例
sf = DistributedSingleFlight(redis_client, local_cache)

# FastAPI 示例接口
@app.get("/fetch")
@sf.wrap(
    key_func=lambda url: f"fetch:{url}",  # 用 url 作为 key
    result_ttl=30,  # 结果缓存 30 秒
    lock_timeout=5  # 锁超时 5 秒
)
async def fetch_resource(url: str):
    """模拟获取远程资源的接口"""
    print(f"实际执行请求: {url} (进程: {id(os.getpid())})")
    # 模拟耗时操作（如数据库查询、网络请求）
    await asyncio.sleep(2)
    return {"url": url, "data": f"content of {url}"}


if __name__ == "__main__":
    import uvicorn
    # 多进程启动（模拟生产环境，workers>1）
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        workers=4,  # 4个进程
        reload=False
    )

```
这里可以看到其实同步版本就是利用多级缓存中是否有key(TTL时效控制)，有的话直接返回，没的话上升到分布式锁，能拿到唯一分布式锁的执行者会将结果缓存到redis 中，其他未拿到锁的跟随者，通过轮询sleep 的方式来等待结果缓存产生，这里相比循环拿锁的串行流程，是在第一个执行者完成后，剩余的并发会在短时间内复用改结果，而不是继续串行执行：  
假设有n 个执行者，每个执行的时间近似为t。这样在使用Singleflight机制的情况下，预期的执行耗时是t，如果单纯使用分布式锁争抢就是n*t。

## 使用异步来进一步优化
直接专注于Singleflight 的核心类定义就行
```python

class AsyncDistributedSingleFlight:
    def __init__(self, redis: Redis, local_cache: TTLCache):
        self.redis = redis
        self.local_cache = local_cache
        self.lock_prefix = "singleflight:lock:"
        self.result_prefix = "singleflight:result:"
        # 进程内的异步锁（防止同一进程内的协程竞争）
        self._local_locks: Dict[str, asyncio.Lock] = {}

    async def _get_local_lock(self, key: str) -> asyncio.Lock:
        """获取进程内的本地锁（每个 key 一个）"""
        if key not in self._local_locks:
            self._local_locks[key] = asyncio.Lock()
        return self._local_locks[key]

    @asynccontextmanager
    async def _distributed_lock(self, key: str, timeout: int = 10):
        """异步分布式锁（基于 Redis）"""
        lock_key = f"{self.lock_prefix}{key}"
        identifier = str(uuid.uuid4())
        
        # 尝试获取锁：SET NX（不存在则设置），并设置过期时间防止死锁
        acquired = await self.redis.set(
            lock_key, identifier, nx=True, ex=timeout
        )
        
        try:
            yield acquired, identifier
        finally:
            # 只有持有锁的进程才能释放锁
            if acquired:
                current = await self.redis.get(lock_key)
                if current == identifier:
                    await self.redis.delete(lock_key)

    async def _get_result(self, key: str) -> Optional[Any]:
        """从 Redis 获取缓存结果"""
        result_key = f"{self.result_prefix}{key}"
        data = await self.redis.get(result_key)
        return json.loads(data) if data else None

    async def _set_result(self, key: str, result: Any, ttl: int = 60):
        """将结果存入 Redis 和本地缓存"""
        result_key = f"{self.result_prefix}{key}"
        await self.redis.set(result_key, json.dumps(result), ex=ttl)
        self.local_cache[key] = result  # 同步更新本地缓存

    async def do(
        self,
        key: str,
        func: Callable,
        *args,
        result_ttl: int = 60,
        lock_timeout: int = 10,
        retry_interval: float = 0.1,
        **kwargs
    ) -> Any:
        """
        异步执行函数，确保同一 key 在多进程/多协程下只有一个实例执行
        :param key: 任务标识
        :param func: 异步函数（需用 async def 定义）
        :param result_ttl: 结果缓存时间（秒）
        :param lock_timeout: 分布式锁超时时间（秒）
        :param retry_interval: 等待结果的重试间隔（秒）
        """
        # 1. 先查本地缓存（最快，避免跨进程交互）
        if key in self.local_cache:
            return self.local_cache[key]
        
        # 2. 获取进程内本地锁（防止同一进程内的多个协程同时竞争分布式锁）
        local_lock = await self._get_local_lock(key)
        async with local_lock:
            # 双重检查本地缓存（防止本地锁等待期间已缓存结果）
            if key in self.local_cache:
                return self.local_cache[key]
            
            # 3. 查 Redis 缓存（跨进程共享的结果）
            cached_result = await self._get_result(key)
            if cached_result is not None:
                self.local_cache[key] = cached_result
                return cached_result
            
            # 4. 竞争分布式锁，执行任务
            async with self._distributed_lock(key, lock_timeout) as (acquired, _):
                if acquired:
                    # 成功获取锁，执行实际任务（确保是异步函数）
                    try:
                        result = await func(*args, **kwargs)  # 异步执行
                        await self._set_result(key, result, result_ttl)
                        return result
                    except Exception as e:
                        # 异常不缓存，直接抛出（可根据需求修改）
                        raise e
                else:
                    # 未获取到锁，循环等待结果（非阻塞等待）
                    while True:
                        result = await self._get_result(key)
                        if result is not None:
                            self.local_cache[key] = result
                            return result
                        # 异步睡眠，不阻塞事件循环
                        await asyncio.sleep(retry_interval)

    def wrap(
        self,
        key_func: Optional[Callable] = None,
        result_ttl: int = 60,
        lock_timeout: int = 10
    ) -> Callable:
        """装饰器版本，用于异步函数"""
        def decorator(func: Callable) -> Callable:
            @wraps(func)
            async def wrapper(*args, **kwargs) -> Any:
                # 生成 key（默认用函数路径+参数生成）
                if key_func:
                    key = key_func(*args, **kwargs)
                else:
                    key = f"{func.__module__}:{func.__name__}:{args}:{tuple(kwargs.items())}"
                return await self.do(
                    key=key,
                    func=func,
                    *args,
                    result_ttl=result_ttl,
                    lock_timeout=lock_timeout,** kwargs
                )
            return wrapper
        return decorator
```
这样能进一步优化一下接口io,不同key 的通过异步能承载更多请求
