---
title: "Kafka_go"
slug: "kafka_go"
description: ""
date: 2024-12-27T11:43:59+08:00
lastmod: 2024-12-27T11:43:59+08:00
draft: false
toc: true
weight: false
musicid: 5264842
categories: ["mq","go","实用代码"]
tags: ["golang"]
image: https://picsum.photos/seed/8391ff80/800/600
---


# Kafka_go
主要是记录下 sarama 库的部署和使用，异步生产者的实现注意
## docker compose 部署
首先 注意下 kafka 数据包所有者
```bash
chown 1001:1001 ./data
```
下面是 docker-compose.yaml 文件
```yaml
 name: "kafka"
 services:
   kafka:
     image: 'bitnami/kafka:3.6.2'
     container_name: kafka
     restart: always
     ulimits:
       nofile:
         soft: 65536
         hard: 65536
     environment:
       - TZ=Asia/Shanghai
       - KAFKA_CFG_NODE_ID=0
       - KAFKA_CFG_PROCESS_ROLES=controller,broker
       - KAFKA_CFG_CONTROLLER_QUORUM_VOTERS=0@kafka:9093
       - KAFKA_CFG_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093,EXTERNAL://:9094
       - KAFKA_CFG_ADVERTISED_LISTENERS=PLAINTEXT://kafka:9092,EXTERNAL://127.0.0.1:9094
       - KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,EXTERNAL:PLAINTEXT
       - KAFKA_CFG_CONTROLLER_LISTENER_NAMES=CONTROLLER
     networks:
       - app-tier
     ports:
       - '9092:9092'
       - '9094:9094'
     volumes:
       - ./data:/bitnami/kafka
 networks:
   app-tier:
     name: app-tier
     driver: bridge

```
注意这里仅仅是非集群模式的部署
## 代码与结果
```go
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/IBM/sarama"
)

var version = sarama.DefaultVersion
var eps = []string{"127.0.0.1:9094"}
var wg sync.WaitGroup

func Producer(topic string, ctx context.Context) {
	defer wg.Done()
	config := sarama.NewConfig()
	config.Version = version
	config.Producer.RequiredAcks = sarama.NoResponse
	config.Producer.Compression = sarama.CompressionSnappy
	config.Producer.Return.Successes = true
	producer, err := sarama.NewAsyncProducer(eps, config)
	if err != nil {
		panic(err)
	}
	defer producer.Close()
    // 注意这里一定要让这些等结果的协程先行退出
	iwg := &sync.WaitGroup{}
	iwg.Add(1)
	go func(ctx context.Context, p sarama.AsyncProducer) {
		iwg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case err := <-p.Errors():
				fmt.Println(err)
			case <-p.Successes():
			}
		}
	}(ctx, producer)
	cnt := 1
	for {
		msg := &sarama.ProducerMessage{
			Topic: topic,
			Value: sarama.StringEncoder(fmt.Sprintf("hello %d", cnt)),
		}
		select {
		case <-ctx.Done():
        // 等待子协程退出
			iwg.Wait()
			return
		case producer.Input() <- msg:
			cnt++
		}
		time.Sleep(1 * time.Second)
	}

}

type TestKafkaGroup struct {
	ctx context.Context
}

func (t *TestKafkaGroup) Setup(session sarama.ConsumerGroupSession) error {
	fmt.Println("setup")
	return nil
}
func (t *TestKafkaGroup) Cleanup(session sarama.ConsumerGroupSession) error {
	fmt.Println("cleanup")
	return nil
}

func (t *TestKafkaGroup) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for {
		select {
		case message, ok := <-claim.Messages():
			if !ok {
				fmt.Printf("message channel was closed")
				return nil
			}
			fmt.Printf("Message claimed: value = %s, partid %d  timestamp = %v\n", string(message.Value), message.Partition, message.Timestamp)
			session.MarkMessage(message, "")
		// Should return when `session.Context()` is done.
		// If not, will raise `ErrRebalanceInProgress` or `read tcp <ip>:<port>: i/o timeout` when kafka rebalance. see:
		// https://github.com/IBM/sarama/issues/1192
		case <-session.Context().Done():
			return nil
		case <-t.ctx.Done():
			return nil
		}
	}
}
func Consumer(topic string, ctx context.Context) {
	defer wg.Done()
	config := sarama.NewConfig()
	config.Version = version
	config.Consumer.Return.Errors = true
	consumer, err := sarama.NewConsumerGroup(eps, topic, config)
	if err != nil {
		fmt.Println(err)
		return
	}
	defer consumer.Close()
	tc := &TestKafkaGroup{ctx: ctx}
	for {
		if err := consumer.Consume(ctx, []string{topic}, tc); err != nil {
			fmt.Println(err)
			if errors.Is(err, sarama.ErrClosedConsumerGroup) {
				return
			}
		}
		if ctx.Err() != nil {
			return
		}

	}
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	wg.Add(1)
	go Producer("test", ctx)
	go Consumer("test", ctx)
	<-quit
	cancel()
	wg.Wait()
}


```

输出结果如下
```bash
setup
Message claimed: value = hello 11, partid 0  timestamp = 2024-12-27 11:29:27.321 +0800 CST
Message claimed: value = hello 1, partid 0  timestamp = 2024-12-27 11:38:33.201 +0800 CST
Message claimed: value = hello 2, partid 0  timestamp = 2024-12-27 11:38:34.201 +0800 CST
Message claimed: value = hello 3, partid 0  timestamp = 2024-12-27 11:38:35.202 +0800 CST
Message claimed: value = hello 4, partid 0  timestamp = 2024-12-27 11:38:36.202 +0800 CST
Message claimed: value = hello 5, partid 0  timestamp = 2024-12-27 11:38:37.203 +0800 CST
Message claimed: value = hello 6, partid 0  timestamp = 2024-12-27 11:38:38.203 +0800 CST
Message claimed: value = hello 7, partid 0  timestamp = 2024-12-27 11:38:39.203 +0800 CST
Message claimed: value = hello 8, partid 0  timestamp = 2024-12-27 11:38:40.203 +0800 CST
Message claimed: value = hello 9, partid 0  timestamp = 2024-12-27 11:38:41.204 +0800 CST
Message claimed: value = hello 10, partid 0  timestamp = 2024-12-27 11:38:42.206 +0800 CST
Message claimed: value = hello 11, partid 0  timestamp = 2024-12-27 11:38:43.206 +0800 CST
Message claimed: value = hello 12, partid 0  timestamp = 2024-12-27 11:38:44.206 +0800 CST
Message claimed: value = hello 13, partid 0  timestamp = 2024-12-27 11:38:45.207 +0800 CST
Message claimed: value = hello 14, partid 0  timestamp = 2024-12-27 11:38:46.208 +0800 CST
Message claimed: value = hello 15, partid 0  timestamp = 2024-12-27 11:38:47.208 +0800 CST
Message claimed: value = hello 16, partid 0  timestamp = 2024-12-27 11:38:48.209 +0800 CST
Message claimed: value = hello 17, partid 0  timestamp = 2024-12-27 11:38:49.209 +0800 CST
Message claimed: value = hello 18, partid 0  timestamp = 2024-12-27 11:38:50.21 +0800 CST
Message claimed: value = hello 19, partid 0  timestamp = 2024-12-27 11:38:51.211 +0800 CST
Message claimed: value = hello 20, partid 0  timestamp = 2024-12-27 11:38:52.211 +0800 CST
^C
cleanup
```