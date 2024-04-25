# TLS 和 H2 配置
------

## TLS 证书签发流程


```shell
# 下面是 v3.ext 的内容
# authorityKeyIdentifier=keyid,issuer
# basicConstraints=CA:FALSE
# keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
# extendedKeyUsage = serverAuth
# subjectAltName = @alt_names

# [alt_names]
# DNS.1=localhost
# DNS.2=10.110.8.36
openssl genrsa > serve.key 
openssl req -new -key serve.key -out serve.csr -subj "/C=GB/L=China/O=hx/CN=localhost" -days 365 -addext "subjectAltName = DNS:localhost"
# 个人感觉 这边加个  -addext "subjectAltName = DNS:localhost" 也可以替代 extfile
openssl x509 -req -sha512 -days 365 -extfile v3.ext -signkey serve.key  -in serve.csr -out serve.crt
```
三个文件：
- serve.key 私钥
- serve.csr 公钥
- serve.crt 给客户端用来验证服务的签名证书

## 代码实现TLS 和H2
服务端这边
```go
	http.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		io.WriteString(w, "hello, world!\n")
	})
    // 这里要指向两个文件的路径
	if e := http.ListenAndServeTLS(":443", "serve.crt", "serve.key", nil); e != nil {
		log.Fatal("ListenAndServe: ", e)
	}
```
客户端这边
```go
package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	"golang.org/x/net/http2"
)

func loadCA(caFile string) *x509.CertPool {
	pool := x509.NewCertPool()

	if ca, e := os.ReadFile(caFile); e != nil {
		log.Fatal("ReadFile: ", e)
	} else {
		pool.AppendCertsFromPEM(ca)
	}
	return pool
}

func main() {
	c := &http.Client{
        // 这个会拿到 h2的协议
		Transport: &http2.Transport{
			TLSClientConfig: &tls.Config{RootCAs: loadCA("../serve.crt")},
			AllowHTTP:       true,
		},
        // 启用下面这个注释的就是 https 的协议
		// Transport: &http.Transport{
		// 	TLSClientConfig: &tls.Config{RootCAs: loadCA("../serve.crt")},
		// },
	}

	if resp, e := c.Get("https://localhost:443/"); e != nil {
		log.Fatal("http.Client.Get: ", e)
	} else {
		defer resp.Body.Close()
		io.Copy(os.Stdout, resp.Body)
		fmt.Printf("Got response %d: %s \n", resp.StatusCode, resp.Proto)
	}
}
```