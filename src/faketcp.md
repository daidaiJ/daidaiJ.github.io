# faketcp 原理简介
------
## 背景
通过udp 实现多路传输时，可能会被运营商通过qos策略给丢掉；通过rawsocket 机制在udp报文上增加tcp 头来伪装成tcp包，通过增加一部封拆包头的代价来换取udp通信的可用性

## 代码实现
这里没有做具体的udp包体封装的例子，但是字节流数据传输可见是完整的，将一个udp报文转成`[]byte`切片来使用
```go

package main

import (
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"sync"
	// "github.com/xitongsys/ethernet-go/header"
)

type TCP struct {
	SrcPort    uint16
	DstPort    uint16
	Seq        uint32
	Ack        uint32
	Offset     uint8
	Flags      uint8
	Win        uint16
	Checksum   uint16
	UrgPointer uint16
	Opt        uint32
}

type IPv4Pseudo struct {
	Src      uint32
	Dst      uint32
	Reserved uint8
	Protocol uint8
	Len      uint16
}

func (h *IPv4Pseudo) Marshal() []byte {
	headerLen := int(12)
	res := make([]byte, headerLen)
	binary.BigEndian.PutUint32(res[0:], h.Src)
	binary.BigEndian.PutUint32(res[4:], h.Dst)
	res[8] = byte(h.Reserved)
	res[9] = byte(h.Protocol)
	binary.BigEndian.PutUint16(res[10:], h.Len)
	return res
}

func (h *TCP) Marshal() []byte {
	res := make([]byte, 20)
	binary.BigEndian.PutUint16(res, h.SrcPort)
	binary.BigEndian.PutUint16(res[2:], h.DstPort)
	binary.BigEndian.PutUint32(res[4:], h.Seq)
	binary.BigEndian.PutUint32(res[8:], h.Ack)
	res[12] = byte(h.Offset)
	res[13] = byte(h.Flags)
	binary.BigEndian.PutUint16(res[14:], h.Win)
	binary.BigEndian.PutUint16(res[16:], h.Checksum)
	binary.BigEndian.PutUint16(res[18:], h.UrgPointer)
	return res
}

func ReCalTcpCheckSum(bs []byte, src, dst uint32) error {
	if len(bs) < 20 {
		return fmt.Errorf("too short")
	}
	ipps := IPv4Pseudo{}
	ipps.Src = src
	ipps.Dst = dst
	ipps.Reserved = 0
	ipps.Protocol = 6
	ipps.Len = uint16(len(bs))

	ippsbs := ipps.Marshal()
	tcpbs := bs
	tcpbs[16] = 0
	tcpbs[17] = 0

	if len(tcpbs)%2 == 1 {
		tcpbs = append(tcpbs, byte(0))
	}

	s := uint32(0)
	for i := 0; i < len(ippsbs); i += 2 {
		s += uint32(binary.BigEndian.Uint16(ippsbs[i : i+2]))
	}
	for i := 0; i < len(tcpbs); i += 2 {
		s += uint32(binary.BigEndian.Uint16(tcpbs[i : i+2]))
	}

	for (s >> 16) > 0 {
		s = (s >> 16) + (s & 0xffff)
	}
	binary.BigEndian.PutUint16(tcpbs[16:], ^uint16(s))
	return nil
}

// https://sourcegraph.com/github.com/xitongsys/ethernet-go@master/-/blob/header/tcp.go
func server(ch chan<- struct{}, wg *sync.WaitGroup) {
	ipaddr, _ := net.ResolveIPAddr("ip4", "127.0.0.2")
	con, err := net.ListenIP("ip4:6", ipaddr)
	if err != nil {
		log.Fatalf("tcp listening failed %+v\n", err)
	}
	buf := make([]byte, 1024)
	fmt.Printf("开始接收%v\n", con.LocalAddr())
	ch <- struct{}{}
	for range 3 {
		{
			n, from, _ := con.ReadFromIP(buf)
			if n > 20 {
				fmt.Printf("[%s] for [%s]\n", string(buf[20:n]), from.String())
			} else {
				fmt.Printf("too short %d\n", n)
			}
		}
	}
	close(ch)
	con.Close()
	wg.Done()
}

const (
	FIN = 0x01
	SYN = 0x02
	RST = 0x04
	PSH = 0x08
	ACK = 0x10
	URG = 0x20
	ECE = 0x40
	CWR = 0x80
)

func BuildTcpHeader(src, dst uint32, sport, dport uint16, flag uint8, data []byte) []byte {
	tcpheader := &TCP{
		SrcPort:    sport,
		DstPort:    dport,
		Seq:        1,
		Ack:        1,
		Offset:     0x50,
		Flags:      flag,
		Win:        ^uint16(0),
		Checksum:   0,
		UrgPointer: 0,
	}
	result := make([]byte, len(data)+20)
	copy(result, tcpheader.Marshal())
	copy(result[20:], data)
	ReCalTcpCheckSum(result, src, dst)
	return result
}

func client(ch <-chan struct{}) {
	laddr, _ := net.ResolveIPAddr("ip4", "127.0.0.3")
	raddr, _ := net.ResolveIPAddr("ip4", "127.0.0.2")
	con, err := net.DialIP("ip4:6", laddr, raddr)
	if err != nil {
		log.Fatalf("ip conn create failed %+v\n", err)
	}
	<-ch
	for i := range 3 {
		buf := BuildTcpHeader(binary.BigEndian.Uint32(laddr.IP.To4()), binary.BigEndian.Uint32(raddr.IP.To4()), 7742, 7743, SYN, []byte(fmt.Sprintf("test data packet%d", i)))
		con.Write(buf)
	}
	<-ch
	fmt.Println("has write")
	con.Close()
}

func main() {
	var wg sync.WaitGroup
	ch := make(chan struct{})
	wg.Add(1)
	go server(ch, &wg)
	fmt.Println("server start")
	client(ch)
	fmt.Println("client close")
	wg.Wait()
}

```
后期会补一些原理图上去