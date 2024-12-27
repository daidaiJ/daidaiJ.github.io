---
title: "Webrtc_go Turn 服务器相关"
slug: "Turn_go"
description: "主要是介绍Pion Turn 库的使用方法"
date: 2024-12-27T14:10:10+08:00
lastmod: 2024-12-27T14:10:10+08:00
draft: false
toc: true
weight: false
musicid: 5264842
categories: ["go","学习笔记"]
tags: ["golang"，"webrtc"]
image: https://picsum.photos/seed/26399c1f/800/600
---

#  Turn 服务
在常用的 Webrtc 教程中通常会为ICE 引入Stun 或者Turn 服务，一般可以用谷歌或者Cloudflare 提供的 stun 服务，也有用开源项目自行搭建的，这里主要是介绍Pion Turn 库的使用方法。
## Credentials 长期凭证

```go
	u, p, _ := turn.GenerateLongTermCredentials(*authSecret, time.Minute)
	if _, err := os.Stdout.WriteString(fmt.Sprintf("%s=%s", u, p)); err != nil { // For use with xargs
		log.Panicf("Failed to write to stdout: %s", err)
	}
```
核心就是根据 鉴权secret 生成长期凭证

## 简单的STUN
```go
package main

import (
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/pion/turn/v4"
)

func main() {
	publicIP := flag.String("public-ip", "", "IP Address that STUN can be contacted by.")
	port := flag.Int("port", 3478, "Listening port.")
	flag.Parse()

	if len(*publicIP) == 0 {
		log.Fatalf("'public-ip' is required")
	}

	// Create a UDP listener to pass into pion/turn
	// pion/turn itself doesn't allocate any UDP sockets, but lets the user pass them in
	// this allows us to add logging, storage or modify inbound/outbound traffic
	udpListener, err := net.ListenPacket("udp4", "0.0.0.0:"+strconv.Itoa(*port))
	if err != nil {
		log.Panicf("Failed to create STUN server listener: %s", err)
	}

	s, err := turn.NewServer(turn.ServerConfig{
		// PacketConnConfigs is a list of UDP Listeners and the configuration around them
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn: udpListener,
                // RelayAddressGenerator: &turn.RelayAddressGeneratorPortRange{
				// 	RelayAddress: net.ParseIP(*publicIP), 
				// 	Address:      "0.0.0.0",              // But actually be listening on every interface
				// 	MinPort:      50000,
				// 	MaxPort:      55000,
				// },
			},
		},
	})
	if err != nil {
		log.Panic(err)
	}

	// Block until user sends SIGINT or SIGTERM
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	<-sigs

	if err = s.Close(); err != nil {
		log.Panic(err)
	}
}
```
这里需要的公网IP 应该用于做中继的，通过`RelayAddressGenerator` 系列函数来实现一个动态负载均衡？
上述turn.NewServer 函数的参数中，可以添加鉴权hanlder 
## 鉴权机制
```go
AuthHandler: func(username string, realm string, srcAddr net.Addr) ([]byte, bool) { // nolint: revive
			if key, ok := usersMap[username]; ok {
				return key, true
			}
			return nil, false
		},
```
这个可以和内置的两种`LongTermTURNRESTAuthHandler`处理时间:用户名对应的验证 对应`GenerateLongTermTURNRESTCredentials`;   `NewLongTermAuthHandler` 处理长期凭证的验证,对应`GenerateLongTermCredentials`
可以先过滤对应鉴权的用户是否存在，再进行下一步的验证
中间注释的`RelayAddressGenerator` 中继地址生成器的配置，可以用于控制中继端口的分配范围，配合防火墙来使用

## 传输层
Turn 支持udp、tcp、tls，配置起来也很简单，直接在turn.NewServer 函数中添加`ListenerConfigs.Listener`,例如使用TLS 的tcp 协议
```go
// 这里两个 File 参数指向的是文件路径
cer, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		log.Println(err)
		return
	}

	// Create a TLS listener to pass into pion/turn
	// pion/turn itself doesn't allocate any TLS listeners, but lets the user pass them in
	// this allows us to add logging, storage or modify inbound/outbound traffic
	tlsListener, err := tls.Listen("tcp4", "0.0.0.0:"+strconv.Itoa(*port), &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{cer},
	})
	if err != nil {
		log.Println(err)
		return
	}
s, err := turn.NewServer(turn.ServerConfig{
		Realm: *realm,
		// Set AuthHandler callback
		// This is called every time a user tries to authenticate with the TURN server
		// Return the key for that user, or false when no user is found
		AuthHandler: func(username string, realm string, srcAddr net.Addr) ([]byte, bool) { // nolint: revive
			if key, ok := usersMap[username]; ok {
				return key, true
			}
			return nil, false
		},
		// ListenerConfig is a list of Listeners and the configuration around them
		ListenerConfigs: []turn.ListenerConfig{
			{
				Listener: tlsListener,
				RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
					RelayAddress: net.ParseIP(*publicIP),
					Address:      "0.0.0.0",
                    MinPort:      50000,
					MaxPort:      55000,
				},
			},
		},
	})
```
## 实现黑名单
```go
	var permissions turn.PermissionHandler = func(clientAddr net.Addr, peerIP net.IP) bool {
		for _, cidr := range conf.TurnDenyPeersParsed {
			if cidr.Contains(peerIP) {
				return false
			}
		}

		return true
	}
    _, err = turn.NewServer(turn.ServerConfig{
		Realm:       Realm,
		AuthHandler: svr.authenticate,
        // TCP 连接
		ListenerConfigs: []turn.ListenerConfig{
			{Listener: tcpListener, RelayAddressGenerator: gen, PermissionHandler: permissions},
		},
        // UDP 连接
		PacketConnConfigs: []turn.PacketConnConfig{
			{PacketConn: udpListener, RelayAddressGenerator: gen, PermissionHandler: permissions},
		},
	})
```
## 使用多线程
使用多线程，看着更像是多个监听线程，所以会有端口重用的需要
```go
    addr, err := net.ResolveUDPAddr("udp", "0.0.0.0:"+strconv.Itoa(*port))
    // Create `numThreads` UDP listeners to pass into pion/turn
	// pion/turn itself doesn't allocate any UDP sockets, but lets the user pass them in
	// this allows us to add logging, storage or modify inbound/outbound traffic
	// UDP listeners share the same local address:port with setting SO_REUSEPORT and the kernel
	// will load-balance received packets per the IP 5-tuple
	listenerConfig := &net.ListenConfig{
		Control: func(network, address string, conn syscall.RawConn) error { // nolint: revive
			var operr error
			if err = conn.Control(func(fd uintptr) {
                // 将socket 关联的fd 描述符配置成  通用套接字配置  地址和端口重用  
				operr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, unix.SO_REUSEPORT, 1)
			}); err != nil {
				return err
			}

			return operr
		},
	}

	relayAddressGenerator := &turn.RelayAddressGeneratorStatic{
		RelayAddress: net.ParseIP(*publicIP), // Claim that we are listening on IP passed by user
		Address:      "0.0.0.0",              // But actually be listening on every interface
	}

	packetConnConfigs := make([]turn.PacketConnConfig, *threadNum)
	for i := 0; i < *threadNum; i++ {
        // 创建一个可以用的本地UDP 监听器
        // 要用net.Listen 
		conn, listErr := listenerConfig.ListenPacket(context.Background(), addr.Network(), addr.String())
		if listErr != nil {
			log.Fatalf("Failed to allocate UDP listener at %s:%s", addr.Network(), addr.String())
		}

		packetConnConfigs[i] = turn.PacketConnConfig{
			PacketConn:            conn,
			RelayAddressGenerator: relayAddressGenerator,
		}

		log.Printf("Server %d listening on %s\n", i, conn.LocalAddr().String())
	}

```
总体来说Pione/turn 还是挺简单易用的；
