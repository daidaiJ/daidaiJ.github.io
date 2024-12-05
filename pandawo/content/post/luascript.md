---
title: "Luascript"
slug: ""
description: ""
date: 2024-12-05T14:42:14+08:00
lastmod: 2024-12-05T14:42:14+08:00
draft: false
toc: true
weight: false
musicid: 5264842
categories: ["实用代码"]
tags: ["golang"]
image: https://picsum.photos/800/600.webp?random=d0ba0f6f
---
# redis Lua 实用脚本

## 计数器
```lua
local key = "daily_data:".. tostring(ARGV[1])
local increment = tonumber(ARGV[2]) 
local currentValue = redis.call('GET', key) 
if currentValue == false then 
	redis.call('SET', key, increment) 
	return increment 
else 
	local newValue = tonumber(currentValue) + increment 
	redis.call('SET', key, newValue) 
	return newValue 
end
```

对应的复用操作
```python
import redis 
import hashlib 
r = redis.Redis() # 定义 Lua 脚本 
lua_script = """ 
local key = "daily_data:".. tostring(ARGV[1])
local increment = tonumber(ARGV[2]) 
local currentValue = redis.call('GET', key) 
if currentValue == false then 
	redis.call('SET', key, increment) 
	return increment 
else 
	local newValue = tonumber(currentValue) + increment 
	redis.call('SET', key, newValue) 
	return newValue 
end
""" # 加载脚本并获取 SHA1 校验和 
sha = r.script_load(lua_script) 
# 使用已加载的脚本执行操作 
date = '20241106' 
increment_value = 10 
new_value = r.evalsha(sha, 2, date, increment_value) 
print(f"更新后的单日累加数据：{new_value}") 
# 再次使用已加载的脚本执行操作 
new_value = r.evalsha(sha, 2, date, increment_value) 
print(f"再次更新后的单日累加数据：{new_value}")
```

对应的go 代码
```go
const luaScript := `
local key = KEYS[1]
local change = ARGV[1]

local value = redis.call("GET", key)
if not value then
  value = 0
end

value = value + change
redis.call("SET", key, value)

return value
`
const DefaultPrefix = "Default"
func getToDayKey() string {
	return fmt.Sprintf("%s:%s", DefaultPrefix, time.Now().Local().Format(time.DateOnly))
}


func Init(){
	cmd := redis.ScriptLoad(luaScript)
	if err:= cmd.Err();err!=nil{
		log.Debug().Msgf("转载lua 脚本错误 %v",err)
	}
}


func Update(delta int)(int,err){

	var incrBy = redis.NewScript(luaScript)
	keys := getToDayKey()
	values := delta 
	return incrBy.Run(ctx, rdb, keys, values...).Int()
}


```

## 分布式集群限流

```lua

local key = KEYS[1]
# 这里能进一步将 limit 和 window 写成常量来避免传值
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(redis.call('TIME')[1])
local countKey = key.. ':'.. math.floor(now / window)
local count = tonumber(redis.call('GET', countKey) or 0)
if count < limit then
    redis.call('INCR', countKey)
    redis.call('EXPIRE', countKey, window)
    return 1
else
    return 0
end

```

## 分布式锁
```lua
local key = KEYS[1]
local value = ARGV[1]
local ttl = tonumber(ARGV[2])
local existingValue = redis.call('GET', key)
if existingValue == false then
    redis.call('SET', key, value, 'PX', ttl)
    return true
elseif existingValue == value then
    redis.call('PEXPIRE', key, ttl)
    return true
else
    return false
end
```