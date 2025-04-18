---
title: "otle"
slug: "otle"
description: "go 服务中使用opentelemetery"
date: 2025-04-18T12:33:17+08:00
lastmod: 2025-04-18T12:33:17+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 308299
categories: ["go","链路追踪"]
tags: ["golang"]
image: https://picsum.photos/seed/55031e83/800/600
---

# 链路追踪示例
``` go
package main

import (
    "context"
    "log"
    "net/http"

    "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    tracesdk "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.17.0"
)

// initTracer 初始化 OpenTelemetry 追踪器
func initTracer() (*tracesdk.TracerProvider, error) {
    ctx := context.Background()

    // 创建一个 OTLP HTTP 导出器
    exp, err := otlptracehttp.New(ctx,
        otlptracehttp.WithInsecure(),
        otlptracehttp.WithEndpoint("localhost:4318"),
    )
    if err != nil {
        return nil, err
    }

    // 创建资源，指定服务名称
    r, err := resource.Merge(
        resource.Default(),
        resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName("my-http-service"),
        ),
    )
    if err != nil {
        return nil, err
    }

    // 创建追踪器提供程序
    tp := tracesdk.NewTracerProvider(
        tracesdk.WithBatcher(exp),
        tracesdk.WithResource(r),
    )

    // 设置全局传播器
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
    // 设置全局追踪器提供程序
    otel.SetTracerProvider(tp)

    return tp, nil
}

func main() {
    // 初始化追踪器
    tp, err := initTracer()
    if err != nil {
        log.Fatalf("Failed to initialize tracer: %v", err)
    }
    defer func() {
        if err := tp.Shutdown(context.Background()); err != nil {
            log.Printf("Error shutting down tracer provider: %v", err)
        }
    }()

    // 定义一个简单的 HTTP 处理函数
    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        // 创建一个新的 span
        ctx, span := otel.Tracer("example-tracer").Start(r.Context(), "handle-root")
        defer span.End()

        // 添加一些属性到 span
        span.SetAttributes(attribute.String("http.method", r.Method))

        // 模拟一些工作
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("Hello, World!"))
    })

    // 使用 otelhttp 包装 HTTP 处理程序
    http.Handle("/", otelhttp.NewHandler(http.DefaultServeMux, "my-http-service"))

    log.Println("Starting server on :8080")
    if err := http.ListenAndServe(":8080", nil); err != nil {
        log.Fatalf("Failed to start server: %v", err)
    }
}    
```
示例代码很明确了，另外就是使用 otle 作为exporter 时可以通过环境变量来配置endpoint 端点 `OTEL_EXPORTER_OTLP_ENDPOINT` 这样可以不用Option 显式配置更加灵活