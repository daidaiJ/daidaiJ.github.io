---
title: elasticsearch learing note
slug: elasticsearch
description: learing query for elasticsearch
date: 2024-12-11T17:02:52+08:00
lastmod: 2024-12-11T17:02:52+08:00
draf: true
toc: true
weight: false
musicid: 5264842
categories:
  - elasticsearch
tags:
  - 笔记
image: https://picsum.photos/seed/d0b120fd/800/600
---

# elasticsearch 菜鸟查询手册
*********************
>  正如你所知道的那样，本人由于不擅长elk 组件，出于学习的目的对用途更加广泛的 elasticsearch 这个核心技术栈的检索api 做了初步的了解和学习


## 索引 & 文档
es 的文档和索引的结构如下：
`/<索引:_index>/<文档类型:_type>/<ID:_id>`  
### 基本操作
**新增**文档
可以通过 PUT 方法去自动创建索引，在请求体body 中通过携带多组键值形式的字段，单个文档的提交就是这样简单
**查询**对应文档
就是对同一个路由调用 GET 方法，在响应的json 中 `_source._key` 的json 路径来获取键对应的字段
**删除** 对应文档
也是调用同路由的DELETE 方法，指定执行删除操作的主分区可能会不可用，可以通过 timeout 参数来控制这个不可用的时间范围，删除时可以通过`if_seq_no`和 `if_primary_term` ，另外删除的时候如果路由分片指定错误，删除操作不会发生
根据查询删除匹配的文档，`POST /_index/_delete_by_query`
**更新**文档也是一个套路，
```json
{  
	"script" : {  
		"source": "ctx._source.counter += params.count",  
		"lang": "painless",  
		"params" : {  
			"count" : 4  
		}  
	}  
}
```

可以看到 是通过 script 中对应 source 字段中对的简单表达式 和 params 中的参数来更新数据的




