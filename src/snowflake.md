# 雪花算法实现

## 雪花算法
0     - 0000000000 0000000000 0000000000 0000000000 0 - 0000000000 - 000000000000

符号位               时间戳                                   机器码         序列号

41位毫秒级时间戳，10位机器id  12位序列号
这个起始时间sEpoch其实不太重要，因为一般业务不会超过10年，这个69-(10~20)总还有50年的余量的，比较重要的一点就是如果一个毫秒内生产的序列id 过多就得等待到下一个毫秒窗口内


## 代码

```go
package utils

// https://sourcegraph.com/github.com/sohaha/zlsgo/-/blob/zstring/snowflake.go
// 学习 zlsgo的总结
import (
	"fmt"
	"sync"
	"time"
)

const (
	sEpoch     = 1474802888000 // 这个可以是业务上线的时间
	TimeBase   = int64(1000000)
	MaxWorkID  = 1<<5 - 1
	MaxDataID  = MaxWorkID
	MaxSeqID   = 1<<12 - 1
	MaskWorkID = 1<<10 - 1
	MaskSeqID  = 1<<12 - 1
)

type SnowFlakeBuilder struct {
	start  int64
	workid int64
	seqid  int64
	lock   sync.Mutex
}

func NewBuilder(st time.Time, data int, worker int) *SnowFlakeBuilder {
	if data < 0 || data > MaxDataID || worker < 0 || worker > MaxWorkID || st.After(time.Now()) {
		panic("invaild argument error")
	}
	return &SnowFlakeBuilder{
		start:  st.UnixNano() / TimeBase,
		workid: int64(data<<5|worker) & MaskWorkID,
	}
}

// 类似自旋锁的逻辑，持续试图获取下一毫秒的时间资源
func (s *SnowFlakeBuilder) waitToNextMS(last int64) int64 {
	ts := time.Now().UnixNano() / TimeBase
	for {
		if ts <= last {
			ts = time.Now().UnixNano() / TimeBase
		} else {
			break
		}
	}
	return ts
}

func (s *SnowFlakeBuilder) GetID() (int64, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	ts := time.Now().UnixNano() / TimeBase
	if ts == s.start {
		s.seqid = (s.seqid + 1) & MaskSeqID
		if s.seqid == 0 {
			ts = s.waitToNextMS(ts)
		}
	} else {
		s.seqid = 0
	}
	if ts < s.start {
		return 0, fmt.Errorf("clock moved backwards, refuse gen id")
	}
	s.start = ts
	ts = (ts-sEpoch)<<22 | s.workid<<12 | s.seqid
	return ts, nil
}
```