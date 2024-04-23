# Prometheus exporter pprof 优化
----
> 这个工程是 基于 Prometheus client-go 的库来开发的，这个库的主要流程是将 collector 的数据用http server的形式通过metrics 路由交出去，背景状况是现在这个收集器的收集间隔很长基本上是6个小时更新一次，但是负责抓取这些指标数据的服务leader 又不同意改成6小时的大跨度，所以之前的措施是把硬件采集的数据缓存起来，但是更新后的版本cpu占用率和响应时间都没太大优化，需要定位这个问题
## 怎么采集后台运行进程性能数据
1. 使用`ps -ef | grep xxx` 来获取进程号pid
   1. ` pidstat -u -p pid  15 4` 来采集进程的cpu 占用率
2. top 按t 和m 来切换 cpu 和 内存排序
3. go 使用  _ "net/http/pprof" 然后非http 网络服务就再增加一个拉起http 服务的几行代码
   1. 使用curl -o cpupgo.out http://your_address:your_port/debug/pprof/profile?seconds=60 来采样一分钟的运行数据
   2.  `go tool pprof -http=:9000 cpupgo.out ` 使用 pprof 工具开启一个网络服务在web网页上查看性能采样
4. 使用 perf 工具来采样 基本上会用到 record 和 report 这些，然后转成火山图来分析

## 问题追踪
**问题1.** 缓存为什么没有生效(降低延迟减少耗时操作)
通过go 的pprof 对后台运行的服务采样后发现大部分cpu 时间在生成Metric 相关的结构体上，同时缓存的数据格式是json，取json 数据会用到仿射，这使得组装Metric 的过程中充斥着大量的耗时操作，于是选择将json 数据缓存改成 Metric 数据缓冲，和时效时间戳一起封装成一个抽象的容器，在未过期时会将，slice 里面所有的Metric 通过管道发送出去，过期时会将slice 长度重置，发送Metric 的同时将其append 到slice 里面缓存，总结来说，缓存生效了，但是又没完全覆盖到所有耗时操作上。

改进后的缓存实现，在应用中遇到了新的问题，缓存应用后没被触发？

**问题2**.  缓存为什么没被触发？
复盘对比了两种缓存机制和Collect 方法被调用的过程时发现，Collect 中声明的对象在每次调用时重新创建的，之前json 缓存是用的全局变量，所以创建前后用的都是一个缓存；这里将新的缓存实现也没大改，给新建的这些对象实例也做个全局缓存，没过期失效前这些实例就不会被重新创建，减少了一些再分配构建的过程，通过预留的 cache stat handler 可以看到缓存除了初次和过期时未命中外，其余时刻缓存全命中，符合预期

新的全局缓冲实现生效了，将cpu 占用率降低到原先的30%，同时内存占用差别不大，但剩下的30%还能不能继续优化呢？

## 终极优化方案

通过对 Prometheus client go 的源码阅读，确定了相应http 响应的整个构造流程，脑中浮现了一个比较极端的想法，缓冲响应；

这个适合用来缓存响应内容在一段时间内不会发生改动的 http handler 接口对象
```go
/* get resp cache code  start  */
type respCacheWriter struct {
	header     http.Header
    expireat time.Time
	statuscode int
	buf        []byte
    update     bool
}
func newRespCacheWriter() *respCacheWriter {
    return &respCacheWriter{
        header: make(http.Header, 3),
		buf:    make([]byte, 0, 1024*4),
	}
}
func (r *respCacheWriter) NotExpire() bool {
    return time.Now().Before(r.expireat)&&!r.update
}
func (r *respCacheWriter) Update(interval time.Duration) {
     r.expireat = time.Now().Add(interval)
     r.update = false
}
func (r *respCacheWriter) Header() http.Header {
	return r.header
}
func (r *respCacheWriter) SetUpdate() http.Header {
	return r.update = true
}

func (r *respCacheWriter) WriteHeader(statusCode int) {
	r.statuscode = statusCode
}

func (r *respCacheWriter) Write(p []byte) (int, error) {
	if p == nil {
		return 0, fmt.Errorf("Write []byte length should not be zero")
	}
	r.buf = append(r.buf, p...)
	return len(r.buf), nil
}

type GetRespCache struct {
	
	interval time.Duration
	cache    map[string]*respCacheWriter
	next     http.Handler
}

func NewGetRespCache(i time.Duration,next http.Handler)GetRespCache{
	return GetRespCache{ 
		interval: i,
		cache: make(map[string]*respCacheWriter,1),
		next: next,
	}
}

// 这个方法其实也可以 转成私有的，但是不会修改cache 状态所以无所谓

func (g *GetRespCache)UpdateCache()bool{
    key := fmt.Sprintf("key%v", r.URL.Query())
    if c,ok:=g.cache[key];key&&c!=nil{
        c.SetUpdate()
    }
}

func (g *GetRespCache) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	key := fmt.Sprintf("key%v", r.URL.Query())
	if val, ok := g.cache[key]; ok  && val != nil&&val.NotExpire() {
		g.generateResp(val, w)
	} else {
		// 调用 write 方法时 缓存响应的 header
		resp := newRespCacheWriter()
		g.next.ServeHTTP(resp, r)
		g.generateResp(resp, w)
		g.update(key, resp)

	}
}
func (g *GetRespCache) update(key string, resp *respCacheWriter) {
    // 这里会更新过期时间和下一个响应状态
	resp.Update(g.interval)
    g.cache[key] = resp
}
func (*GetRespCache) generateResp(val *respCacheWriter, w http.ResponseWriter) {
	for k, s := range val.header {
		for _, v := range s {
			w.Header().Set(k, v)
		}
	}
	w.WriteHeader(val.statuscode)
	w.Write(val.buf)
}
/* get resp cache code  end  */

```
可以看到其实就是通过中间的代理接口，将被代理的handler 函数的修改缓存起来，根据get 请求的query值来做hash 返回响应的；
过期的时效间隔这里倒是比较粗，用的是同一个过期间隔；

这个get 缓存方案是我最看好的:
- 第一点基本上是即插即用，迁移性好兼容性好，
- 第二点是性能更好，缓存占用少，还剩去了内部handler 处理的时间

这个之所以能用在这个场景上，其实是需求造成的，抓取端不改动，数据供应端又允许缓存；所以这个getcache 的方案理论上有奇效，但是最终还是没应用上这个，确定是按照问题2解决后的实现方案来。