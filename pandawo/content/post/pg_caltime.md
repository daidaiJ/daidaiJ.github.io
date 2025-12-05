---
title: "使用pg 对资源用时进行统计"
slug: "pg"
description: "Use pg database to count online time"
date: 2025-12-05T17:00:24+08:00
lastmod: 2025-12-05T17:00:24+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["pg","python"]
tags: ["python"]
image: https://picsum.photos/seed/b5d0f0ca/800/600
---
# 使用pg统计资源用时
近期项目上有个相关资源用时统计的需求，我个人想了一个简单的统计demo
## 大致需求
有个资源有唯一id ，需要根据开机时间，关机时间统计按当天（近似实时），天，周，月，年的维度计算用时数据
拆解下来最基本的计算逻辑时天和当天这两种，下文会简单说下其他的几个维度咋统计或者查询
计算当天和昨天的需求可以被抽象成一个逻辑：
查找开始时间到截止（当下或者昨天最后一秒）的资源用时。
先给个简单的创建表结构语句示例：
```sql
CREATE TABLE machine_runtime (
    id SERIAL PRIMARY KEY,
    machine_id VARCHAR(50) NOT NULL,  -- 机器ID
    start_time TIMESTAMP NOT NULL,   -- 开机时间
    end_time TIMESTAMP               -- 关机时间（可为空）
);
```
这里开机时创建一个记录，有开机时间，但是关机时间为空，可以将主键记录在资源实体记录中，或者关机时查机器id 相关记录中关机时间为空的那个补上这个关机时间，于是这个开关机记录有两种：
- 有开机时间没关机，说明是还在运行中的，就将查询时间当成统计截止时间来计算用时
- 用关机时间，需要比较这个开机时间是否比筛选的开始范围更晚
```sql
 select round(sum( extract (epoch from (  least(COALESCE(end_time,'2025-12-04T23:59:59'),'2025-12-04T23:59:59')-GREATEST(start_time,'2025-12-04T00:00:00')) ) )
/3600,0) as cost_hour from machine_runtime where machine_id='1;
```
上述是查询语句示例：
在12-05 结算前一天的特定机器的用时，如果是计算当天的只需要改动下起止时间点，于是根据pg 的函数定义方式得出了下面的函数创建语句
```sql
CREATE OR REPLACE FUNCTION calculate_machine_hour_batch(p_machine_id VARCHAR(50),p_start_time TIMESTAMP,p_end_time TIMESTAMP)
RETURNS TABLE (cost_hour NUMERIC) AS 
$$
BEGIN
    RETURN QUERY
    SELECT
        ROUND(
            SUM(EXTRACT(EPOCH FROM (
                LEAST(COALESCE(m.end_time, p_end_time), p_end_time) - GREATEST(m.start_time, p_start_time)
            ))) / 3600, 0
        ) AS cost_hour
    FROM machine_runtime m
    WHERE m.machine_id = p_machine_id AND (( m.start_time>p_start_time) or m.end_time is null);
END;
$$ 
LANGUAGE plpgsql;
```
整个过程被封装成查询某个id 的起止时间内多段开关机记录的用时总和，用法如下：
```sql
 select  calculate_machine_hour_batch('1','2025-12-04T00:00:00','2025_12-04T23:59:59') as cost_time;
 cost_time
-----------
        15
(1 row)
```

看起来还是很简单的
## python 怎么查询
在python 中可以通过sqlmodel 执行原生sql 的方式简化查询
```python
def get_machine_runtime_hour(
    machine_id: str,
    start_time: str,  # 格式如 "2025-12-04T00:00:00"
    end_time: str     # 格式如 "2025-12-04T23:59:59"
) -> Optional[int]:
    """
    调用PostgreSQL的calculate_machine_hour函数，获取机器用时（小时，取整）
    """
    # 函数调用的SQL语句（注意PostgreSQL函数调用的语法）
    sql = """
        SELECT calculate_machine_hour(
            %s::varchar,
            %s::timestamp,
            %s::timestamp
        ) AS cost_hour;
    """
    
    with Session(engine) as session:
        # 执行原生SQL，传入参数（避免SQL注入）
        result = session.exec(
            sql,
            params=[machine_id, start_time, end_time]
        ).first()  # 获取单行结果
    
    # 结果解析：返回整数小时数（无数据则返回None）
    return int(result) if result is not None else 0
```
## 周，月，年怎么处理
上面其实已经论述了怎么计算前一天的用时数据，那其他维度的过去用量其实都是可以按照天来定时更新，按照id ，时间维度的开始日期或者就是时间，来确定一个周，月，年的资源统计记录，然后把这个增量数据（天）加上去，这个就是出去当天之前的其他维度数据的计算，通过存放到多个表里来以查代算，只用每天定时更新前一天的就可以把计算的维度缩小到一天之中，控制聚合的记录数量，剩下就是重复走当天用量的计算逻辑。 这里看下来通过创建这三个字段的聚合索引可以完成初步优化
```sql
CREATE INDEX idx_machine_runtime_covering ON machine_runtime (
    machine_id, start_time
) INCLUDE (end_time);  
```