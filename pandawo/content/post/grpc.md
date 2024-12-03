---
title: "gRPC 使用手册"
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
tags : 
    - 应用层协议
---
# gRPC 使用手册
---
## 环境准备 
grpc 是使用protobuf 协议的
需要安装对应的编译器
```shell
 go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.28
 go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.2
```
定义好 .proto 文件之后可以使用 protoc 编译器来生成对应语言的代码
```shell
protoc --go_out=./proto/ --go_opt=paths=source_relative 
    --go-grpc_out=./proto/ --go-grpc_opt=paths=source_relative  ./proto/your.proto
```
## 基础的流程
```go
// 单次调用
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	resp, err := client.UnaryEcho(ctx, &ecpb.EchoRequest{Message: message})
	if err != nil {
		log.Fatalf("client.UnaryEcho(_) = _, %v: ", err)
	}

// 流接收
func recvMessage(stream pb.Echo_BidirectionalStreamingEchoClient, wantErrCode codes.Code) {
	res, err := stream.Recv()
	if status.Code(err) != wantErrCode {
		log.Fatalf("stream.Recv() = %v, %v; want _, status.Code(err)=%v", res, err, wantErrCode)
	}
	if err != nil {
		fmt.Printf("stream.Recv() returned expected error %v\n", err)
		return
	}
	fmt.Printf("received message %q\n", res.GetMessage())
}

// 在接受流的时候要验证 err 是不是EOF
for {
		in, err := stream.Recv()
		if err != nil {
			fmt.Printf("server: error receiving from stream: %v\n", err)
			if err == io.EOF {
				return nil
			}
			return err
		}
		fmt.Printf("echoing message %q\n", in.Message)
		stream.Send(&pb.EchoResponse{Message: in.Message})
	}

```

## OAuth token 验证
因为有两种rpc 调用 一种是 单次调用 一种是流式调用；
在客户端 client 建立连接时使用的opts 中使用
```go
// fetchToken 表示获取token 的动作,使用 tokensource 获取带时效时间的 token 
	perRPC := oauth.TokenSource{TokenSource: oauth2.StaticTokenSource(fetchToken())}
	creds, err := credentials.NewClientTLSFromFile(data.Path("x509/ca_cert.pem"), "x.test.example.com")
	if err != nil {
		log.Fatalf("failed to load credentials: %v", err)
	}
	opts := []grpc.DialOption{
		// In addition to the following grpc.DialOption, callers may also use
		// the grpc.CallOption grpc.PerRPCCredentials with the RPC invocation
		// itself.
		// See: https://godoc.org/google.golang.org/grpc#PerRPCCredentials
		grpc.WithPerRPCCredentials(perRPC),
		// oauth.TokenSource requires the configuration of transport
		// credentials.
		grpc.WithTransportCredentials(creds),
	}
```
在服务端则是要通过拦截器来分别处理两种 rpc 调用的验证
```go
// 流式的 验证 
func ensureValidToken(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return nil, errMissingMetadata
	}
	// 下面这个是将客户端传的token 和服务器端的校验逻辑来比较
	if !valid(md["authorization"]) {
		return nil, errInvalidToken
	}
	// Continue execution of handler after ensuring a valid token.
	return handler(ctx, req)
}
	cert, err := tls.LoadX509KeyPair(data.Path("x509/server_cert.pem"), data.Path("x509/server_key.pem"))
	if err != nil {
		log.Fatalf("failed to load key pair: %s", err)
	}
	opts := []grpc.ServerOption{
		grpc.UnaryInterceptor(ensureValidToken),
		// Enable TLS for all incoming connections.
		grpc.Creds(credentials.NewServerTLSFromCert(&cert)),
	}

```
这里也是可以用 go-grpc-middleware 提供的auth 中间件来实现验证函数的包装
## 取消调用

取消调用里面要在用grpc 调用时传入上下文作为第一个参数来控制rpc 调用过程；
```go
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	stream, err := c.BidirectionalStreamingEcho(ctx)
	if err != nil {
		log.Fatalf("error creating stream: %v", err)
	}
    cancel()
    // 此时已经取消任务了，
```
## 压缩请求
```go
// 旧版本在 NewClient() 的时候传一个 grpc.WithCompressor(grpc.NewGZIPCompressor())
// 新版本需要在调用的时候传入
grpc.UseCompressor(gzip.Name)
```

## grpc限流
用go-grpc-middleware实现一个接口来在grpc 中间件里做限流，限流中间件必须排在后面，避免令牌被浪费了，使用原生的方式可以基于服务来做特定任务的限流；
在示例中用定时器触发模拟限流机制产生，当服务端调用阻塞的时候，退出后续的批量任务，

## 请求失败重试策略配置

```go
	
	var retryPolicy = `{
		"methodConfig": [{ 
		  "name": [{"service": "grpc.examples.echo.Echo"}], //应用的服务
		  "waitForReady": true,	// 是否等待
		  "retryPolicy": {
			  "MaxAttempts": 4,
			  "InitialBackoff": ".01s",
			  "MaxBackoff": ".01s",
			  "BackoffMultiplier": 1.0,
			  "RetryableStatusCodes": [ "UNAVAILABLE" ]
		  }
		}]}`

// use grpc.WithDefaultServiceConfig() to set service config
func retryDial() (*grpc.ClientConn, error) {
	return grpc.NewClient(*addr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDefaultServiceConfig(retryPolicy))
}

```
## 等待对端恢复
```go
// 在需要等待对端恢复服务的时候可以加入这个option
grpc.WaitForReady(true)
```

##  携带元数据
这个元数据有点像 http 里面的 header 的作用，携带一些用于配置的的内容
客户端这边需要用
```go
 metadata.Pairs("timestamp", time.Now().Format(timestampFormat)) // 来添加组装键值对，两个字符串作为一组，转换成一个KV对，键值对的键可以有重复的
 ctx := metadata.NewOutgoingContext(context.Background(), md)
 // 然后 封装成一个上下文通过 grpc 调用传过去
 var header, trailer metadata.MD
 r, err := c.UnaryEcho(ctx, &pb.EchoRequest{Message: message}, grpc.Header(&header), grpc.Trailer(&trailer))
 // 这个 header 和 trailer 是

```
服务端对这个元数据做交互
```go
md, ok := metadata.FromIncomingContext(ctx)
	header := metadata.New(map[string]string{"location": "MTV", "timestamp": time.Now().Format(timestampFormat)})
	grpc.SendHeader(ctx, header)
	// 执行grpc 服务
	// 下面逻辑要在defer 函数里面执行
	trailer := metadata.Pairs("timestamp", time.Now().Format(timestampFormat))
	grpc.SetTrailer(ctx, trailer)

```
感觉可以用来做rpc 调用的时延监控，或者调用前后状态的跟踪点
## grpc 长连接保活
```go
var kacp = keepalive.ClientParameters{
	Time:                10 * time.Second, // send pings every 10 seconds if there is no activity
	Timeout:             time.Second,      // wait 1 second for ping ack before considering the connection dead
	PermitWithoutStream: true,             // send pings even without active streams
}
// 新建客户端时带上这个 grpc.DialOption
conn, err := grpc.NewClient(*addr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithKeepaliveParams(kacp))

```
## 负载平衡
默认的连接构建策略是 使用首个配置构建两件，如果需要使用负载平衡机制
```go
// 使用轮转策略
roundrobinConn, err := grpc.NewClient(
		fmt.Sprintf("%s:///%s", exampleScheme, exampleServiceName),
		grpc.WithDefaultServiceConfig(`{"loadBalancingConfig": [{"round_robin":{}}]}`), // This sets the initial balancing policy.
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)

```