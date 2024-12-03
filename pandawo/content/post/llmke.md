---
title: "llm 知识抽取管线"
description: 
date: 2024-12-02T22:36:03+08:00
image: 
math: 
license: 
hidden: false
comments: true
musicid: 5264842
categories:
    - 笔记
    - 实用代码
tags : 
    - ai
---
# llm 知识抽取管线
------
> 利用prompt模板，从文档中抽取出知识，并控制输出格式，完成知识抽取管线
## prompt模板
```python
KE_PROMPT= """你现在是一个用于抽取结构化信息的知识抽取模型，请按照遵守下面的步骤提取结构化的实体关系:
- 步骤 -
1. 识别所有在实体类型列表:{node_lists}中给出类型的实体，提取以下信息，同时保持实体一致性：
    - name 实体名称，尽量简单明确，不要包含多余信息；
    - type 实体类型，必须是实体类型列表中给出的类型；
    - desc 实体描述，可以实体属性和相关活动的描述；
    将每个实体输出为json格式，其格式如下，键值内容不要包含单双引号，格式如下：
    {{"name":"<实体名称>","type":"<实体类型>","desc":"<实体描述>"}}；
2. 针对步骤1中获取的实体，识别所有在关系类型列表:{relation_lists}中给出类型的关系，提取以下信息：
    - src 源实体的名称，即步骤1中标识的name
    - dst 目标实体的名称，即步骤1中标识
    - rel 关系类型，必须是关系类型列表中给出的类型；
    - rel_desc 说明源实体和目的实体存在实体关系的原因
    将每个关系输出转化成以下的json格式:格式如下:
    {{"src":"<源实体名称>","dst":"<目标实体名称>","rel":"<关系类型>","rel_desc":"<关系描述>""}}
3. 请保证按照上述规则输出，不要输出其他内容。
- 真实数据 -
#############
{text}
#############
输出:"""

def main():
    node_lists = ["人物", "地点", "组织","事件"]
    relation_lists = ["位于", "就职于","发生了","谈论"]
    test = "昨天实验室的牛师兄带着常师哥去面馆吃了八十八碗面，然后谈论面上项目的一些筹划，准备结合从所在的大数据实验室的重点方向挖掘项目创新点"
    print(KE_PROMPT.format(node_lists=node_lists,relation_lists=relation_lists,text=test))

if __name__ == '__main__':
    main()
```
## openai 或者gpt 大模型http 非流式调用

这部分可以参照之前的那个chatgpt 桌面版调用不同厂商的sdk 接口，用来组装成流水线