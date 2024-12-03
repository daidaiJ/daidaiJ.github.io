---
title: "异步日志写实现"
description: 
date: 2024-12-02T22:36:03+08:00
image: 
math: 
license: 
hidden: false
comments: true
musicid: 5264842
categories:
    - 实用代码
tags : 
    - golang
    - 异步io
    - 日志
---
# 异步日志写实现


## 设计逻辑

内置 sync.pool 获取缓存，将 p 写入 bytes.Buffer，写入成功就将 buff 入队，然后使用轮询函数在循环中一直取队列里面的 buffer，使用刷写将缓存内容落盘，同时将缓存返回池中。在进程做优雅退出的时候，关联到异步写者，让其 for range 剩余的缓存，连续落盘； 落盘写函数逻辑：

1. 要写入的字节流长度是否大于缓存剩下的部分？
   1. 是将当前写缓存内容刷写落盘，
   2. 否 直接追加到写缓存后面 异步轮询的 poller 函数会从队列里面取出 next writer，如果不是空的就直接执行缓存操作，这部分用 select 来做个定时操作，如果较长时间没有新的日志进来，就先把缓存里面有的数据落盘



## go 代码实现

```go

type FixSizeLargeBuff struct {
	buf []byte
}

const Megabit = 1024 * 1024

func NewFixSizeLargeBuff() *FixSizeLargeBuff {
	return &FixSizeLargeBuff{buf: make([]byte, 0, Megabit)}
}
func (f *FixSizeLargeBuff) Avail() int {
	return Megabit - len(f.buf)
}
func (f *FixSizeLargeBuff) Reset() {
	f.buf = f.buf[:0]
}
func (f *FixSizeLargeBuff) Append(p []byte) (int, error) {
	if f.Avail() < len(p) {
		return 0, fmt.Errorf("no avail free bytes")
	}
	f.buf = append(f.buf, p...)
	return len(p), nil
}

type SimpleAsyncWriter struct {
	data     chan *FixSizeLargeBuff
	curbuff  *FixSizeLargeBuff
	buffpool sync.Pool
	wt       io.Writer
	lock     sync.Mutex
	wg       sync.WaitGroup
	ct       *time.Ticker
	last     time.Time
	active   chan struct{}
}

func NewSimpleAsyncWriter(w io.Writer, limit int) *SimpleAsyncWriter {
	ret := &SimpleAsyncWriter{
		data: make(chan *FixSizeLargeBuff, limit),
		buffpool: sync.Pool{New: func() any {
			return NewFixSizeLargeBuff()
		}},
		wt:     w,
		lock:   sync.Mutex{},
		active: make(chan struct{}),
		ct:     time.NewTicker(1 * time.Second),
	}
	ret.addCount()
	go ret.poller()
	return ret
}
func (s *SimpleAsyncWriter) addCount() {
	s.wg.Add(1)
}
func (s *SimpleAsyncWriter) Write(p []byte) (int, error) {
	select {
	case <-s.active:
		return 0, ErrorWriteAsyncerIsClosed
	default:
	}

	s.last = time.Now()
	s.lock.Lock()
	defer s.lock.Unlock()
	select {
	case <-s.active:
		return 0, ErrorWriteAsyncerIsClosed
	case <-s.ct.C:
		if s.curbuff.Avail() > 0 && time.Since(s.last) > 5*time.Second {
			s.data <- s.curbuff
			s.curbuff = s.buffpool.Get().(*FixSizeLargeBuff)
		}
	default:

		if s.curbuff == nil {
			s.curbuff = s.buffpool.Get().(*FixSizeLargeBuff)
		}
		if len(p) > s.curbuff.Avail() {
			s.data <- s.curbuff
			s.curbuff = s.buffpool.Get().(*FixSizeLargeBuff)

		}
	}

	if n, err := s.curbuff.Append(p); err != nil {
		return n, err
	}
	return len(p), nil

}

func (s *SimpleAsyncWriter) poller() {

	defer func() {

		for i := len(s.data); i > 0; i-- {
			d := <-s.data
			s.wt.Write(d.buf)
		}
		if s.curbuff.Avail() > 0 {
			s.wt.Write(s.curbuff.buf)
		}
		close(s.data)
		s.data = nil
		s.ct.Stop()
		s.wg.Done()
	}()

	for {
		select {
		case <-s.active:
			goto outer
		case d := <-s.data:
			s.wt.Write(d.buf)
			d.Reset()
			s.buffpool.Put(d)
		}
	}
outer:
}

func (s *SimpleAsyncWriter) Stop() {
	s.active <- struct{}{}
	s.wg.Wait()
}
```

## 基准测试

使用 [law](https://gitee.com/link?target=https%3A%2F%2Fgithub.com%2Fshengyanli1982%2Flaw) 的 benckmark 测试并给 BlackHoleWriter 类的 Writer 增加了时延模拟真实的落盘耗时，使用随机预先生成的字节数组队列来模拟真实负载填充，下面是 benckmark 测试的耗时

![benchmark 测试结果](asset/alog.png)

第一列是测试项-cpu 数，第二列是每秒钟执行的次数，第三列是耗时，第四列是每个操作分配的字节数(这个可能是我预生成的随机字节数组拷贝时产生的)，第五列是每个操作的分配次数 

可以看到在 write 写操作平均耗时和平均分配的字节数来看，都有比较明显的优化，同时因为利用 defer 和 wait 机制联动，可以保证在调用 stop 是已经写入缓存的内容可以安全落盘，可以优雅推出，同步机制使用原生 channel 管道

**特点**

- 轻量级，代码简洁封装少，使用原生操作实现
- 多缓冲，使用sync.Pool 实现多级缓冲
- 安全并发， 虽然使用了互斥锁，但是仅用在write 方法上，对性能影响足够小
