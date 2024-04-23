# 消息订阅实现

## 原理
go 的消息管道可以看成一个并发安全的队列，每个订阅者将字节的收信队列添加到SubHub 里面，按照订阅的topic 和 channel 的关系用一个 `map[string]chan` 来实现关联，当Hub 接受到对应topic 的消息推送的时候，会给slice 里面的收信队列发事件消息

## 实现

```go
import (
	"sync"
	"time"
)

type HEvent struct {
	Data  interface{}
	Topic string
}

type HEventData chan HEvent
type HEventDataArray []HEventData //一个topic 可以有多个消费者

type HEventBus struct {
	sub map[string]HEventDataArray
	rm  sync.RWMutex
}


func HEventSrv() *HEventBus {
	return h
}

func (h *HEventBus) Sub(topic string, ch HEventData) {
	h.rm.Lock()
	if chanEvent, ok := h.sub[topic]; ok {
		h.sub[topic] = append(chanEvent, ch)
	} else {
		h.sub[topic] = append([]HEventData{}, ch)
	}
	defer h.rm.Unlock()
}

func (h *HEventBus) Push(topic string, data interface{}) {
	h.rm.RLock()
	defer h.rm.RUnlock()
	if chanEvent, ok := h.sub[topic]; ok {
		for _, ch := range chanEvent {
			ch <- HEvent{
				Data:  data,
				Topic: topic,
			}
		}
	}
}

func (h *HEventBus) PushFullDrop(topic string, data interface{}) {
	h.rm.RLock()
	defer h.rm.RUnlock()
	if chanEvent, ok := h.sub[topic]; ok {
		for _, ch := range chanEvent {
			select {
			case ch <- HEvent{
				Data:  data,
				Topic: topic,
			}:
			case <-time.After(time.Second):
			}
		}
	}
}

```