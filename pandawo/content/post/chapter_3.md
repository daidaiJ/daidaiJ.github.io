---
title: "文件多格式压缩工具rust实现"
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
    - rust
---https://
# 文件多格式压缩
----
> 使用了一个压缩集合库来实现的这部分功能
> [compress](https://github.com/klauspost/compress)
## 代码实现
```go
package kit

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	gzip "github.com/klauspost/compress/gzip"
	snappy "github.com/klauspost/compress/s2"
	zip "github.com/klauspost/compress/zip"
	zstd "github.com/klauspost/compress/zstd"
)

/* compress file func  start */
// go build:+ linux
var osChown = os.Chown

type (
	CompressType int
	ZWriter      interface {
		io.WriteCloser
		Flush() error
	}
)

const (
	GZIP_TYEP CompressType = iota
	ZSTD_TYPE
	SNAPPY_TYPE
	ZIP_TYPE
)

var suffixs = [4]string{".gz", ".zst", ".snappy", ".zip"}

func chown(name string, info os.FileInfo) error {
	f, err := os.OpenFile(name, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	f.Close()
	stat := info.Sys().(*syscall.Stat_t)
	return osChown(name, int(stat.Uid), int(stat.Gid))
}

func CompressLogFile(src, dst string, ct CompressType, rm bool) (err error) {
	f, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("failed to open log file: %v", err)
	}
	defer f.Close()
	if dst == src {
		dst += "out"
	}
	fi, err := os.Stat(src)
	if err != nil {
		return fmt.Errorf("failed to stat log file: %v", err)
	}

	if !strings.HasSuffix(dst, suffixs[ct]) {
		dst += suffixs[ct]
	}
	if err := chown(dst, fi); err != nil {
		return fmt.Errorf("failed to chown compressed log file: %v", err)
	}

	// If this file already exists, we presume it was created by
	// a previous attempt to compress the log file.
	zf, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, fi.Mode())
	if err != nil {
		return fmt.Errorf("failed to open compressed log file: %v", err)
	}
	defer zf.Close()
	if ct == ZIP_TYPE {
		w := zip.NewWriter(zf)

		_, filename := filepath.Split(src)
		temp, err := w.Create(filename)
		if err != nil {
			return err
		}
		if _, err := io.Copy(temp, f); err != nil {
			w.Close()
			return err
		}
		if err := w.Close(); err != nil {
			return err
		}
	} else {

		var zwriter ZWriter
		switch ct {
		case GZIP_TYEP:
			zwriter = gzip.NewWriter(zf)
		case SNAPPY_TYPE:
			zwriter = snappy.NewWriter(zf, snappy.WriterSnappyCompat())
		case ZSTD_TYPE:
			zwriter, _ = zstd.NewWriter(zf)
		}

		defer func() {
			if err != nil {
				os.Remove(dst)
				err = fmt.Errorf("failed to compress log file: %v", err)
			}
		}()

		if n, err := io.Copy(zwriter, f); err != nil {
			zwriter.Close()
			return err
		} else {
			fmt.Printf("debug %d byets has beed write to dst path %s", n, dst)
		}
		zwriter.Flush()
		if err := zwriter.Close(); err != nil {
			return err
		}
	}
	if err := zf.Close(); err != nil {
		return err
	}

	if err := f.Close(); err != nil {
		return err
	}
	if rm {
		if err := os.Remove(src); err != nil {
			return err
		}
	}

	return nil
}

```
这部分主要是通过枚举加分支逻辑来处理不同压缩格式的处理，通过io.Copy 来做数据管道