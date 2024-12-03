---
title: "etcd go 手册"
description: "备忘录"
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
    - golang
---
# ETCD 手册

## KV 操作 

WithIgnoreLease() 使用租约时可以用这个，当key 不存在时会返回错误
WithPrevKV() 可以返回更新前的KV值
WithIgnoreValue() 普通put 使用这个key不存在时会返回错误
WithSort(clientv3.SortByKey, clientv3.SortDescend) 可以让在查询的时候使用特定的排序方式
WithPrefix() 这可以可以按照key，查找前缀是key字符串的所有值；
Get() 使用的WithRev(presp.Header.Revision) ，中的版本号可以时某次put操作返回的版本号，我觉得get的其实也是可以的；

> 看了下源码 ResponseHeader 这东西里面塞了：
> ClusterId 和这个消息交互的集群的id  
> MemberId 节点id 
> Revision 消息版本
> RaftTerm 选举的周期
```go
    // 这里获取版本后，该版本之前的历史数据存储开始进行合并压缩
    // 这里会生成快照吗？ 按照文档上说这个操作应该是要定时进行的
    compRev := resp.Header.Revision // specify compact revision of your choice

    ctx, cancel = context.WithTimeout(context.Background(), requestTimeout)
    _, err = cli.Compact(ctx, compRev)

```
`func (Maintenance).Status(ctx Context, endpoint string)  ` 可以获取集群的状态
`func (Maintenance).Defragment(ctx Context, endpoint string) ` 这可以开启etcd 的碎片整理
## 授权管理
先是简单的通过用户名密码来验证
```go
// 这部分可以手动来进行的 
// etcdctl --user root role add r
    if _, err = cli.RoleAdd(context.TODO(), "r"); err != nil {
            log.Fatal(err)
    }
// etcdctl --user root role grant-permission r   foo zoo
// 使用 -prefix=true 可以仅指定开头前缀
    if _, err = cli.RoleGrantPermission(context.TODO(),"r",   "foo", "zoo", clientv3.PermissionType(clientv3.PermReadWrite),); err != nil {
            log.Fatal(err)
    }
// etcdctl --user root user add  u --new-user-password 123
    if _, err = cli.UserAdd(context.TODO(), "u", "123"); err != nil {
            log.Fatal(err)
    }
// etcdctl --user root user grant-role u r
    if _, err = cli.UserGrantRole(context.TODO(), "u", "r"); err != nil {
            log.Fatal(err)
    }
// etcdctl auth enable
    if _, err = cli.AuthEnable(context.TODO()); err != nil {
            log.Fatal(err)
    }

    // 这里使用 root 角色的用户来登录
    rootCli, err := clientv3.New(clientv3.Config{
        Endpoints:   exampleEndpoints(),
        DialTimeout: dialTimeout,
        Username:    "root",
        Password:    "123",
    })
    if err != nil {
        log.Fatal(err)
    }
    defer rootCli.Close()
    // root 用户可以获取别的 用户或者角色的数据 etcdctl --user root role get r
    resp, err := rootCli.RoleGet(context.TODO(), "r")
    if err != nil {
        log.Fatal(err)
    }
    // 可以获得 角色权限的信息
    fmt.Printf("user u permission: key %q, range end %q\n", resp.Perm[0].Key, resp.Perm[0].RangeEnd)
    // 这里关闭身份校验 etcdctl auth disable
    if _, err = rootCli.AuthDisable(context.TODO()); err != nil {
        log.Fatal(err)
    }

```
建立客户端连接时使用的证书
```go
	tlsInfo := transport.TLSInfo{
			CertFile:      "/tmp/test-certs/test-name-1.pem",
			KeyFile:       "/tmp/test-certs/test-name-1-key.pem",
			TrustedCAFile: "/tmp/test-certs/trusted-ca.pem",
		}
	tlsConfig, err := tlsInfo.ClientConfig()
		if err != nil {
			log.Fatal(err)
		}
		cli, err := clientv3.New(clientv3.Config{
			Endpoints:   exampleEndpoints(),
			DialTimeout: dialTimeout,
			TLS:         tlsConfig,
		})
```
## 事务
> STM is an interface for software transactional memory.
事务使用 MVCC多版本控制，在事务执行的函数类使用 STM 来读写键值
```go
// Txn 这个简单的事务接口，还是基于客户端连接来的
    kvc := clientv3.NewKV(cli)

		_, err = kvc.Put(context.TODO(), "key", "xyz")
		if err != nil {
			log.Fatal(err)
		}

    ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
    // if 条件成立 会执行 then 分支的修改，否则会执行else 分支的操作
    _, err = kvc.Txn(ctx).
        // txn value comparisons are lexical
        If(clientv3.Compare(clientv3.Value("key"), ">", "abc")).
        // the "Then" runs, since "xyz" > "abc"
        Then(clientv3.OpPut("key", "XYZ")).
        // the "Else" does not run
        Else(clientv3.OpPut("key", "ABC")).
        Commit()
//
    exchange := func(stm concurrency.STM) {
            from, to := rand.Intn(totalAccounts), rand.Intn(totalAccounts)
            if from == to {
                // nothing to do
                return
            }
            // read values
            fromK, toK := fmt.Sprintf("accts/%d", from), fmt.Sprintf("accts/%d", to)
            fromV, toV := stm.Get(fromK), stm.Get(toK)
            fromInt, toInt := 0, 0
            fmt.Sscanf(fromV, "%d", &fromInt)
            fmt.Sscanf(toV, "%d", &toInt)

            // transfer amount
            xfer := fromInt / 2
            fromInt, toInt = fromInt-xfer, toInt+xfer

            // write back
            stm.Put(fromK, fmt.Sprintf("%d", fromInt))
            stm.Put(toK, fmt.Sprintf("%d", toInt))
            return
        }

    // concurrently exchange values between accounts
    var wg sync.WaitGroup
    wg.Add(10)
    for i := 0; i < 10; i++ {
        go func() {
            defer wg.Done()
            if _, serr := concurrency.NewSTM(cli, func(stm concurrency.STM) error {
                exchange(stm)
                return nil
            }); serr != nil {
                log.Fatal(serr)
            }
        }()
    }
    wg.Wait()

```
普通的 kv api 其实也有一个Txn ,但是同一个key 只能修改一次
```go
    orderingKv := ordering.NewKV(cli.KV,
            func(op clientv3.Op, resp clientv3.OpResponse, prevRev int64) error {
                return errOrderViolation
            })
	orderingTxn := orderingKv.Txn(ctx)
	_, err = orderingTxn.If(
		clientv3.Compare(clientv3.Value("b"), ">", "a"),
	).Then(
		clientv3.OpGet("foo"),
	).Commit()
	if err != nil {
		t.Fatal(err)
	}


```
## 租约
租约有点像 go 里面的上下文，租约过期时会撤销掉这期间的更改；同时在`func (Lease).Revoke(ctx Context, id LeaseID) `释放租约的时候，之前修改会被视作失效了；`func (Lease).KeepAliveOnce(ctx Context, id LeaseID) ` 可以手动续约，避免租约超期被取消了；
> key 和 Lease 是多对一的关系。一个 key 最多只能挂绑定一个 Lease ，但是一个 Lease 上能挂多个 key 。租约在申请下来后，关联的操作，我觉得全是修改，会被关联到这个租约的 map 里面，这段事件应该是独占这些个 key 的所有权，所以加进来的key修改，在租约失效的时候，反向调用Txn 来删除这些key，就能把之前的版本恢复

```go
	lease, err := cli.Grant(context.Background(), 100)
	if err != nil {
		t.Fatal(err)
	}
    // 每个会话会有一个唯一的ID 和TTL 存活时间
	s, err := concurrency.NewSession(cli, concurrency.WithLease(lease.ID))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	assert.Equal(t, s.Lease(), lease.ID)

	go s.Orphan()
	select {
	case <-s.Done():
	case <-time.After(time.Millisecond * 100):
		t.Fatal("session did not get orphaned as expected")
	}

```
使用租约来控制的会话会比租约更早结束，以免出现并发控制的问题？这个和上面的互斥锁连用就可以实现租约时长来控制的互斥锁，超时会退出，并撤销操作？
另外可以给租约设置 TTL 也就是生存时间
```go
	s, err := concurrency.NewSession(cli, concurrency.WithTTL(setTTL))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	leaseID := s.Lease()
	// TTL retrieved should be less than the set TTL, but not equal to default:60 or exprired:-1
	resp, err := cli.Lease.TimeToLive(context.Background(), leaseID)
	if err != nil {
		t.Log(err)
	}
	if resp.TTL == -1 {
		t.Errorf("client lease should not be expired: %d", resp.TTL)

	}
	if resp.TTL == 60 {
		t.Errorf("default TTL value is used in the session, instead of set TTL: %d", setTTL)
	}
	if resp.TTL >= int64(setTTL) || resp.TTL < int64(setTTL)-20 {
		t.Errorf("Session TTL from lease should be less, but close to set TTL %d, have: %d", setTTL, resp.TTL)
	}
```
这里可以看到 租约的实际时间是比设置的要短的
```go
	lease, err := cli.Grant(context.Background(), 100)
	if err != nil {
		t.Fatal(err)
	}
	s, err := concurrency.NewSession(cli, concurrency.WithLease(lease.ID))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	assert.Equal(t, s.Lease(), lease.ID)
    // 主要是通过 会话的上下文的Done 来控制会话内操作的退出
	childCtx, cancel := context.WithCancel(s.Ctx())
	defer cancel()

	go s.Orphan()
	select {
	case <-childCtx.Done():
	case <-time.After(time.Millisecond * 100):
		t.Fatal("child context of session context is not canceled")
	}

```
会话和 go 原生的上下文的使用；
总结一下：
- 租约加 会话加互斥锁 可以实现分布式锁
- 租约加会话加 上下文，可以取消会话内协程的执行
## 分布式锁
 etcd 3有个并发api ，调用这个api 可以实现分布式锁，锁会持有到主动解锁或者租期到了
 ```go
	// 新建会话是一个标准流程表，因为下面申请锁需要通过一个会话来进行
	s1, err := concurrency.NewSession(cli)
	if err != nil {
		t.Fatal(err)
	}
	defer s1.Close()
	m1 := concurrency.NewMutex(s1, "/my-lock/")
    if err = m1.Lock(context.TODO()); err != nil {
    t.Fatal(err)
    }
    // 这之间就是s1 获得锁的临界区
    if err := m1.Unlock(context.TODO()); err != nil {
    t.Fatal(err)
    }
 ```
如果先调用解锁，会得到ErrLockReleased 也就是锁已经被释放了，或者没有获得锁，总而言之就是当前没有持有锁


## 服务发现和注册
实际是etcd根据mainID去磁盘查数据，磁盘中数据以revision.main+revision.sub为key(bbolt 数据库中的key)，所以就会依次遍历出所有的版本数据。同时判断遍历到的value中的key(etcd中的key)是不是用户watch的，是则推送给用户。

这里每次都会遍历数据库性能可能会很差，实际使用时一般用户只会关注最新的revision，不会去关注旧数据。
> 采用了MVCC，以一种优雅的方式解决了锁带来的问题。执行写操作或删除操作时不会再原数据上修改而是创建一个新版本。这样并发的读取操作仍然可以读取老版本的数据，写操作也可以同时进行。这个模式的好处在于读操作不再阻塞，事实上根本就不需要锁。
> 客户端读key的时候指定一个版本号，服务端保证返回比这个版本号更新的数据，但不保证返回最新的数据。
> MVCC能最大化地实现高效地读写并发，尤其是高效地读，非常适合读多写少的场景。

客户端使用watch 来获取服务端地址
```go
    var serviceTarget = "Hello"
    type remoteService struct {
      name string
      nodes map[string]string
      mutex sync.Mutex
    }
    service = &remoteService {
      name: serviceTarget
    } 
    kv := clientv3.NewKV(etcdClient)
    rangeResp, err := kv.Get(context.TODO(), service.name, clientv3.WithPrefix())
    if err != nil {
       panic(err)
    }

    service.mutex.Lock()
    for _, kv := range rangeResp.Kvs {
        service.nodes[string(kv.Key)] = string(kv.Value)
    }
    service.mutex.Unlock()

    go watchServiceUpdate(etcdClient, service)


// 监控服务目录下的事件
func watchServiceUpdate(etcdClient clientv3.Client, service *remoteService) {
    watcher := clientv3.NewWatcher(client)
    // Watch 服务目录下的更新
    watchChan := watcher.Watch(context.TODO(), service.name, clientv3.WithPrefix())
    for watchResp := range watchChan {
        // 这里对增删时间的响应，会使用互斥锁来解决并发的数据修改问题
          for _, event := range watchResp.Events {
                service.mutex.Lock()
                switch (event.Type) {
                    case mvccpb.PUT://PUT事件，目录下有了新key
                      service.nodes[string(event.Kv.Key)] = string(event.Kv.Value)
                    case mvccpb.DELETE://DELETE事件，目录中有key被删掉(Lease过期，key 也会被删掉)
                      delete(service.nodes, string(event.Kv.Key))
                }
                service.mutex.Unlock()
          }
    }
}

```
服务端主要是注意租约的维护
```go
// 将服务注册到etcd上
func RegisterServiceToETCD(ServiceTarget string, value string) {
    dir = strings.TrimRight(ServiceTarget, "/") + "/"

    client, err := clientv3.New(clientv3.Config{
        Endpoints:   []string{"localhost:2379"},
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
    panic(err)
    }

    kv := clientv3.NewKV(client)
    lease := clientv3.NewLease(client)
    var curLeaseId clientv3.LeaseID = 0

    for {
        if curLeaseId == 0 {
            leaseResp, err := lease.Grant(context.TODO(), 10)
            if err != nil {
              panic(err)
            }

            key := ServiceTarget + fmt.Sprintf("%d", leaseResp.ID)
            if _, err := kv.Put(context.TODO(), key, value, clientv3.WithLease(leaseResp.ID)); err != nil {
                  panic(err)
            }
            curLeaseId = leaseResp.ID
        } else {
      // 续约租约，如果租约已经过期将curLeaseId复位到0重新走创建租约的逻辑
            if _, err := lease.KeepAliveOnce(context.TODO(), curLeaseId); err == rpctypes.ErrLeaseNotFound {
                curLeaseId = 0
                continue
            }
        }
        time.Sleep(time.Duration(1) * time.Second)
    }
}
```
使用 watch 监视的时候 clientv3.WithRev(1) 可以指定从哪个版本开始获取，clientv3.WithFragment() 会允许服务端将事件分页发送过来
```go
select {
	case ws := <-wch:
		// 没启用分页的时候，因为对应的 key 的值太大了，旧没接收到
		if !fragment && exceedRecvLimit {
			if len(ws.Events) != 0 {
				t.Fatalf("expected 0 events with watch fragmentation, got %d", len(ws.Events))
			}
			exp := "code = ResourceExhausted desc = grpc: received message larger than max ("
			if !strings.Contains(ws.Err().Error(), exp) {
				t.Fatalf("expected 'ResourceExhausted' error, got %v", ws.Err())
			}
			return
		}

		// 启用分页将每次发送的数据分成限制内大小后，拿到的分页数，这个事件本身是键值对的一个切片，里面的元素是类似CPP 的 pair 这种键值二元组
		if len(ws.Events) != 10 {
			t.Fatalf("expected 10 events with watch fragmentation, got %d", len(ws.Events))
		}
		if ws.Err() != nil {
			t.Fatalf("unexpected error %v", ws.Err())
		}

	case <-time.After(testutil.RequestTimeout):
		t.Fatalf("took too long to receive events")
	}
```
使用 cfg.ClientMaxCallRecvMsgSize = 1.5 * 1024 * 1024 修改集群配置时，会限制集群给客户端发送消息大小
## 观测
```go
import(
	grpcprom "github.com/grpc-ecosystem/go-grpc-prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)
    // 这样在客户端的 grpc 连接里面塞两个Prometheus的中间件进去
		cli, err := clientv3.New(clientv3.Config{
			Endpoints: exampleEndpoints(),
			DialOptions: []grpc.DialOption{
				grpc.WithUnaryInterceptor(grpcprom.UnaryClientInterceptor),
				grpc.WithStreamInterceptor(grpcprom.StreamClientInterceptor),
			},
		})
        if err!=nil{
            log.Fatal(err)
        }
        defer cli.close()
        // 开个 http 服务端
        ln, err := net.Listen("tcp", ":0")
        if err != nil {
			log.Fatal(err)
		}
        defer ln.close()
        http.Serve(ln, promhttp.Handler()) // 现在就可以被监听到了

```
## 调优
**io优先级** 
```shell
sudo ionice -c2 -n0 -p `pgrep etcd`
```
**快照触发数量**
```shell
etcd --snapshot-count=5000
```
**心跳和选举时间**
```shell
 etcd --heartbeat-interval=100 --election-timeout=500
```
**cpu**
```shell
echo performance | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
```
## 一些维护操作
```shell
etcdctl member list -w table  # 可以查看节点信息
etcdctl move-leader  XXID   --endpoints 127.0.0.1:2379 
etcdctl member remove xxxID
# 重新将一个节点添加到集群里面来
etcdctl member add etcd01 --peer-urls="https://xxxxxxx:2380"
# 对某个节点存储快照
etcdctl --endpoints=https://10.184.4.240:2380 snapshot save snapshot.db
# 从节点快照恢复数据
etcdctl snapshot restore snapshot.db --name etcd01 --initial-cluster etcd01=https://10.184.4.238:2379,etcd02=https://10.184.4.239:2379,etcd03=https://10.184.4.240:2379  --initial-cluster-token etcd-cluster --initial-advertise-peer-urls https://10.184.4.238:2380
```
使用客户端api 也是可以实现上面的操作的
```go
// 添加一个 节点进来   2380 一般是这个端口，用来做集群间通信的，那个2379的是用监听客户端的
    mresp, err := cli.MemberAdd(context.Background(), []string{"http://localhost:32380"})
    if err != nil {
    	log.Fatal(err)
    }
    fmt.Println("added member.PeerURLs:", mresp.Member.PeerURLs)
    fmt.Println("members count:", len(mresp.Members))

    // Restore original cluster state
    _, err = cli.MemberRemove(context.Background(), mresp.Member.ID)
    if err != nil {
    	log.Fatal(err)
    }
          // 这个添加进来做从节点？
       mresp, err := cli.MemberAddAsLearner(context.Background(), []string{"http://localhost:32381"})
    if err != nil {
    	log.Fatal(err)
    }
          // 这里用来获取集群的节点列表
          resp, err := cli.MemberList(context.Background())
    if err != nil {
    	log.Fatal(err)
    }
          // 修改节点的内部通信地址
          peerURLs := []string{"http://localhost:12380"}
    _, err = cli.MemberUpdate(context.Background(), resp.Members[0].ID, peerURLs)
    if err != nil {
    	log.Fatal(err)
    }


```
## 快照
etcd 的快照和虚拟机的快照比较类似，是摸一个时间点etcd 节点的所有数据；快照是一个checkpoint，避免因为wal 数据被无限制写入，导致体量超大，通过checkpoint做一个记录，后续的wal可以做增量，checkpoint生成的快照充当的应该是快照前的数据，发生修改后的数据会在wal上，(也不能这么说，因为wal记录本来就是修改记录)。