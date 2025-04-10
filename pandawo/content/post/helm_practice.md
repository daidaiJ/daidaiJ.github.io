---
title: "记一次helm部署重构实践"
slug: "Helm_practice"
description: "以及helm 部署重构的实践笔记"
date: 2025-04-10T16:05:57+08:00
lastmod: 2025-04-10T16:05:57+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 109532
categories: ["实践笔记"]
tags: ["helm","cd","实践笔记"]
image: https://picsum.photos/seed/f30dabd9/800/600
---

# 记一次helm 部署重构实践
-----
> 背景: 项目上会通过一个自研的部署管理平台来向设备上推送服务部署，随着时间和合作项目的增多，我负责业务的服务也多起来了，为了简化项目管理，将同业务的项目的部署整合的需求被发下来了：
> 1. 需要支持多项目组合，通过values.yaml 来选择不同的项目部署方案
> 2. 要兼容现有部署平台，避免额外的修改

## 依赖和子Charts
我们内部用的部署方案是 helm chart ， 基于这一点最简单的组合策略就是通过依赖和condtion 的组合来控制不同依赖的子chart 是否被启用。
要实现这一方案有以下的几点需要注意：  
1. condition 所引用的key 如果在values 中访问不到，默认会是启用，所以需要在values 中显式禁用未使用的服务
2. 使用依赖去实现多应用组合部署需要，增加一个更新或者构建helm 依赖的流程：
    - `helm dependency update`
    - `helm dependency build`
3. 构建时通过 --set 传入的变量，只能通过 `global` 来传递给子Chart ，因为values 中显式覆盖子Chart 的变量才会在子Chart 中生效

上述 1. 2两点是迫使我放弃子Chart 方案的主要原因

## 使用条件模板
```yaml
{{ if and ( hasKey .Values "service_xxx")  .Values.service_xxx.enabled }}
{{ $projectScopeValue := .Values.service_xxx }}
{{ $projectName := "your-project-name" }}
apiVersion: v1
kind: ConfigMap
metadata:
    namespace: yourNamespace
    name: {{ printf "%-configmap" $projectName }}
data:
{{ (.Files.Glob (printf "%s/etc/*" $projectName)).AsConfig | indent 2 }}
-----
{{- $customValues := tpl (.Files.Get (printf "%s/%s" $projectName (default "values.yaml" $projectScopeValue.valuesFile) )) . | fromYaml -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: yourNamespace
  name: {{ $projectName }}
.....
spec:
  selector:
    matchLabels:
        ....
  replicas: 1
  strategy:
    type: RollingUpdate
  template:
    metadata:
      labels:
       .....
    spec:
      containers:
      - name: yourImageName
        image: "yourImage:{{ $customValues.imageVersion }}"
        imagePullPolicy: IfNotPresent
        tty: true
        securityContext:
          privileged: true
        env:
        - name: TZ
          value: 'Asia/Shanghai'

{{ end }}
```
1. 上述模板文件中通过最外围的 service_xxx.enabled 的values 变量来控制使用启用服务，同时不显式声明为true 的情况下，服务默认不会启用
2. 可以通过.Values.xxx 来传递一些和部署环境有关的控制信息
3. 将原始存储镜像版本号和指定运行时配置的数据通过嵌套子目录给复用上了，同时在自动构建过程中各个服务的镜像版本号更新也可以通过子目录隔离来减小风险  

如下**values模板** 示例说明了如何灵活配置组合不同服务和配置文件
```yaml
# 修改 配置项，对应 chart 配置文件目录名
service_a:
  enabled: true
  config_file: config.test # 可以用来指定非子目录下的 etc 中使用的配置文件 
service_b:
  enabled: true            # 是否启用此服务，默认关闭
  valuesFile: values.yaml  # 可以用来指定非子目录的 values 文件中的镜像版本号
```
### 目录结构
```txt
--project-a/
--.--etc/
---.--test.yaml
---.--default.yaml # 不同values 配置
--project-b/
--templates/
--.--a.deploy.yaml
--.--b.deploy.yaml
--Chart.yaml
--values-a.yaml
--values-b.yaml
```