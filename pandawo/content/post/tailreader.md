---
title: "TailReader 一个反向迭代器"
description: 
date: 2024-12-02T22:36:03+08:00
image: 
math: 
license: 
hidden: false
comments: true
musicid: 5264842
categories:
    - 小工具
tags : 
    - golang
---
# TailReader 一个反向迭代器
------
> 面对大文本获取最后的消息，向前遍历go 目前没有现成的接口

## 设计思路
1. seek 反向移动offset ，然后bytes 判断不同系统上的换行符在哪里？
2. 将一次分割后的字节数组，缓存起来，留待下次取分行字节
3. 在多次未能查看到换行符的时候，默认是3KB 就提前终止提交失败，避免因为错误遍历大二进制文件
4. 有缓存机制，大小文件效率都不差，适合做类似 tail -n 3 这种文本获取行为
5. 目前支持的 empty 行跳过行为比较简单，其实更接近于剔除前缀换行符, 如果需要跳过空行，可以嵌套个if 判断len(temp)>0 
6. 面对极小文件可以直接用ReadFile 来切split，避免带来额外的复杂度

## 实现细节

```go

type TailReader struct {
	rc        *os.File
	buf       []byte    // 用来缓存剩余字节
	temp      []byte   // 提供给 Read
	sep       []byte   // 兼容不同系统架构分隔符
	offset    int64   // 记录offset
	size      int64   // 文件大小
	skipempty bool    // 控制是否跳过空行行为
	atEnd     bool    // 记录offset 是否被移动到文件开始位置了
}

var (
	Sep_win   = []byte("\r\n")
	Sep_linux = []byte("\n")
)

func NewTailReader(fname string, sep []byte, skip bool) (*TailReader, error) {
	file, err := os.Open(fname)
	if err != nil {
		return nil, err
	}
	stat, _ := file.Stat()
	size := stat.Size()
	var offset int64 = 1024
	if size < offset {
		offset = size
	}

	_, errs := file.Seek(int64(-offset), 2)
	if errs != nil {
		return nil, errs
	}
	offset2, _ := file.Seek(0, io.SeekCurrent)
	fmt.Printf("seek to offset %d, file size is %d\n", offset2, size)
	atEnd := false
	if offset == size {
		atEnd = true
	}
	return &TailReader{rc: file, buf: make([]byte, 0, 1024), temp: make([]byte, 1024), sep: sep, skipempty: skip, offset: int64(offset), size: size, atEnd: atEnd}, nil
}

func (t *TailReader) Close() {
	t.rc.Close()
}

func (t *TailReader) ReadBytes() ([]byte, error) {
	// 如果上次缓存没清完，检查是否有换行符
	sepsize := 0
	if t.skipempty {
		sepsize = len(t.sep)
	}
	// 处理上次遗留的缓存
	if len(t.buf) > 0 {
		if idx := bytes.LastIndex(t.buf, t.sep); idx != -1 {
			temp := append([]byte{}, t.buf[idx+sepsize:]...)
			t.buf = t.buf[:idx]
			return temp, nil
		}
		if t.atEnd {
			p := slices.Clone(t.buf[:len(t.buf)])
			t.buf = t.buf[:0]
			return p, nil
		}
	}

	if t.size < t.offset {
		return nil, io.EOF
	}
	// 拷贝重置缓存
	var p []byte
	// 先将这部分尾巴给卸除出去
	if len(t.buf) > 0 {
		p = append([]byte{}, t.buf...)
	}
	n, err := t.rc.Read(t.temp)
	if err == nil && n > 0 {
		idx := bytes.LastIndex(t.temp[:n], t.sep)

		if idx != -1 {

			temp := append([]byte{}, t.temp[idx+sepsize:n]...)
			temp = append(temp, p...)
			t.buf = t.buf[:0]
			t.buf = append(t.buf, t.temp[:idx]...)
			if err := t.move(n); err != nil {
				return nil, err
			}
			return temp, nil
		}

		var cur, next []byte

		cur = slices.Concat(t.temp[:n], p)
		if err := t.move(n); err != nil {
			return nil, err
		}
		// 用来预防二进制大文件，堆爆slice
		for i := 0; i < 3 && idx == -1; i++ {
			n, err = t.rc.ReadAt(t.buf, 0)
			if err != nil {
				return nil, err
			}
			if err := t.move(n); err != nil {
				return nil, err
			}
			idx = bytes.LastIndex(t.buf[:n], t.sep)
			if idx != -1 {
				next = slices.Concat(t.temp[idx:n], cur)
				// 尽量复用
				t.buf = t.buf[:0]
				t.buf = append(t.buf, t.temp[:idx]...)
				break
			}
			next = slices.Concat(t.temp[:n], cur)
		}

		if idx != -1 {
			return nil, errors.New("cant found sep in many times try")
		}

		return next, nil
	}
	return nil, err
}

func (t *TailReader) move(delta int) error {
	t.offset += int64(delta)
	if t.offset > t.size {
		t.offset = t.size
	}
	// 避免重复移动
	if t.offset <= t.size && !t.atEnd {

		_, err := t.rc.Seek(-t.offset, 2)
		if err != nil {
			return err
		}
		if t.offset == t.size {
			t.atEnd = true
		}
	}
	if len(t.buf) > 0 {
		return nil
	}
	return io.EOF
}
```
## 简单使用示例

```go
   f, err := NewTailReader(`test.txt`, utils.Sep_win, true)
   if err != nil {
   fmt.Printf("error %s", err.Error())
   }
   defer f.Close()
   for {

   b, e := f.ReadBytes()
   // 一般是 io.EOF
   if e != nil {
   break
   }
   fmt.Printf("%s\t%v\n", string(b), e)
   }

```
[1](./BingSiteAuth.xml)