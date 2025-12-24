---
title: "Sqlmodel 官方文档之外的操作"
slug: "sqlmodel advance action"
description: "官方教程之外的实用内容"
date: 2025-12-23T18:10:06+08:00
lastmod: 2025-12-23T18:10:06+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["orm","实用操作"]
tags: ["python"]
image: https://picsum.photos/seed/9c84c14d/800/600
---

# SqlModel 教程之外的实用操作
sqlmodel 官方的一些教程基本上都是偏向python 查询到model 实例再操作的循环流程，对于一些可能有大批量数据的场景来说不是很友好，毕竟cython 比数据操作会更慢。
下面就是近期遇到并发掘的一些实用操作
## 同异步会话创建
```python
from contextlib import asynccontextmanager,contextmanager
from typing import AsyncIterator, Iterator
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy import AsyncAdaptedQueuePool, create_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import Session
from sqlmodel.ext.asyncio.session import AsyncSession



async_engine = create_async_engine(
    async_url, # 异步dsn  postgresql+asyncpg://
    echo=app.settings.ECHO,
    future=True,
    pool_size=2,
    max_overflow=30,
    pool_recycle=3600,
    pool_pre_ping=True,
    poolclass=AsyncAdaptedQueuePool,
)

AsyncSessionLocal = async_sessionmaker(
    bind=async_engine,
    class_=AsyncSession,
    expire_on_commit=False,  # 避免commit后属性过期
)


@asynccontextmanager
async def get_async_session() -> AsyncIterator[AsyncSession]:
    """ """

    async with AsyncSessionLocal() as session:
        yield session
        await session.commit()
        

sync_engine = create_engine(
    sync_url,  # postgresql+psycopg2://
    echo=app.settings.ECHO,
    pool_size=2,
    max_overflow=30,
    pool_recycle=3600,
    pool_pre_ping=True,
)

SyncSessionLocal = sessionmaker(
    bind=sync_engine,
    class_=Session,
    expire_on_commit=False,  # 避免commit后属性过期
)

@contextmanager
def get_sync_session()->Iterator[Session]:
    with SyncSessionLocal() as session:
        yield session
        session.commit()

```
通过上下文管理器装饰器来支持`with` 和 `async with` 自动commit 提交更改

## count 数据计数
```python
    with get_session() as session:
        stmt = select(func.count()).where(col(TestData.status)==StatusEnums.ACTIVE)
        count = session.exec(stmt)
        if cnt:=count.first():
            print(f"get cnt {cnt}")  # get cnt xx
```
其实本质上就是用`sqlmodel.func` 底下的 count 函数做了 `count(*) 操作` 
## 批量更新及删除
```python

    with get_session() as session:
        # 更新 status 为inactive 的变成 banned 状态
        stmt_update =update(TestData).where(col(TestData.status)==StatusEnums.INACTIVE).values(status=StatusEnums.BANNED)
        session.exec(stmt_update)
        session.commit()
        # 删除所有 banned 状态的数据，慎重
        stmt_delete =delete(TestData).where(col(TestData.status)==StatusEnums.BANNED)
        session.exec(stmt_delete)
        session.commit()
```
> session.exec(stmt_delete) 在传入非select 语句的时候低版本会被pylance 报错，重载不支持，其实可以执行,忽视类型检查就行  

这里用的是sqlmodel 的`update` 和`delete` 表达式

## pg 方言冲突时更新
```python
from sqlmodel import Session, select,insert
from sqlalchemy.dialects.postgresql import insert as pg_insert ,Insert
from .models.creation_template import CreationTemplate

def update_creation_template(session:Session,uuid:list[str],creation_type:Optional[str],template_id:Optional[str],commit:bool=False):
    if len(uuid)==0 or creation_type is None : # 兼容旧传参
        return 
    data  = [{"res_uuid": x,"creation_type":creation_type,"template_id":template_id } for x in uuid]
    stmt:Insert = pg_insert(CreationTemplate).values(data)
    # 这里一定要 重新赋值
    stmt = stmt.on_conflict_do_update(index_elements=[CreationTemplate.res_uuid],set_={CreationTemplate.creation_type:creation_type,CreationTemplate.template_id:template_id})
    session.execute(stmt)
    if commit:
        session.commit()
```
`stmt = stmt.on_conflict_do_update(index_elements=[CreationTemplate.res_uuid],set_={CreationTemplate.creation_type:creation_type,CreationTemplate.template_id:template_id})`   这行一定要重新赋值，因为on_conflict_do_update 不是原地替换inpalce，是传统的链式调用的模式，这样有相同主键的就会更新字段内容
其实更简单的是 `session.merge(instance)` 会先查再更新或者创建，但是性能上会差一些，也不适合批量更新