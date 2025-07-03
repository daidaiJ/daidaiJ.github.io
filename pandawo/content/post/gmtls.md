---
title: "Gmtls"
slug: "gmtls"
description: "一个使用国密双向认证的demo 示例"
date: 2025-07-03T15:27:35+08:00
lastmod: 2025-07-03T15:27:35+08:00
draft: false
toc: true
hidden: false
weight: false
qqmusic: 4932444
categories: ["go","tcp","mqtt"]
tags: ["golang"]
image: https://picsum.photos/seed/8ebdf5d2/800/600
---

# 双向认证
-----
> 最近的一个项目合规要求使用国密算法实现双向认证，这里就将国密和常见的X509 RSA 的双向认证的实现都分享一下

## RSA 双向认证

```go
import (
    "crypto/tls"
    "crypto/x509"
    "io/ioutil"
    "net"
)
func UseX509TLS(carootpath,certpath,keypath string)(*tls.Config,error){
    certPool := x509.NewCertPool()
    cacert, err := ioutil.ReadFile(carootpath)
    if err != nil {
        return nil, err
    }
    certPool.AppendCertsFromPEM(cacert)
    authKeypair, err := tls.LoadX509KeyPair(certpath, keypath)
    if err != nil {
        return nil, err
    }
    return &tls.Config{
        MaxVersion:         tls.VersionTLS12,
        RootCAs:            certPool,
        Certificates:       []tls.Certificate{authKeypair},
        InsecureSkipVerify: false,
    }, nil
}

func ClientConn(addr string)(*net.Conn,error){
    // 三个分别是 ca证书路径，客户端证书路径，客户端私钥路径
    cfg,err := UseX509TLS("ca.crt","client.crt","client.key")
    //
    conn,err := tls.Dial("tcp", addr, cfg)
    if err!= nil{
        return nil, err
    }
    return &conn, nil
}

```
这里的客户端证书和密钥是给服务端用于认证客户端的身份，同时使用指定的ca 根证书
这里用在mqtt 上就很简单了，甚至不用写连接创建的函数`opts.SetTLSConfig(tlsConfig)` 里面将tls 配置进去，mqtt 库会自动完成
## 国密双向认证
这里就比较复杂一些了，因为目前go 的标准库的暂不支持国密认证，需要使用`github.com/tjfoc/gmsm` 这个仓库，来建立国密认证连接，仅配置tls 是不行的，需要

```go

func GMTLSDialer(broker string, ca, key, cert string) (net.Conn, error) {
	cfg, err := BothAuthConfig(ca, key, cert)
	if err != nil {
		return nil, err
	}
	addr := broker
	if strings.HasPrefix(broker, "mqtt://") {
		addr = broker[7:]
	}
	fmt.Printf("addr: %s\n", addr)
	conn, err := gmtls.Dial("tcp", addr, cfg)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

func BothAuthConfig(ca, key, cert string) (*gmtls.Config, error) {
	// 信任的根证书
	certPool := x509.NewCertPool()
	cacert, err := os.ReadFile(ca)
	if err != nil {
		return nil, err
	}
	certPool.AppendCertsFromPEM(cacert)
	authKeypair, err := gmtls.LoadX509KeyPair(cert, key)
	if err != nil {
		return nil, err
	}
	return &gmtls.Config{
		GMSupport:          &gmtls.GMSupport{},
		RootCAs:            certPool,
		Certificates:       []gmtls.Certificate{authKeypair},
		InsecureSkipVerify: false,
	}, nil

}

func MqttOpenConnectionFn(uri *url.URL, options mqtt.ClientOptions) (net.Conn, error) {
	return cert.GMTLSDialer(cfg.Mqtt.Addr, 
                            "ca.crt",
                            "client.crt",
                            "client.key"，
                            )
}
```
最后如何在mqtt 中使用呢`opts.SetCustomOpenConnectionFn(MqttOpenConnectionFn)` 这样就行