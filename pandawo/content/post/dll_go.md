---
title: "dll_go"
slug: "go,dll,no cgo"
description: "use dll with go ,not cgo"
date: 2025-09-29T10:51:48+08:00
lastmod: 2025-09-29T10:51:48+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["ffi","go"]
tags: ["golang"]
image: https://picsum.photos/seed/d91a0fe0/800/600
---
# golang 调用dll 实践
-----
> 众所周知，go 支持通过cgo 方式直接嵌入c/cpp 代码，但是有时候涉及到ffi 的部分仅仅是一小部分的业务功能，没有必要开混编。  

这里记录下近期发掘到的一种通过封装的dll 来动态调用c库的方法。个人觉得这种方式提升了灵活性，有利于实现部分功能的热更新，对于目前ai 应用的混编部署也是一种简约的模式，函数调用优于网络调用。

## dll 部分
c 和cpp 里面 宽窄字符串一直是比较恶心的一点，这里就用它做示例
```cpp
#include<iostream>
#include <string>
#include <locale>
#include <windows.h>  // 引入Windows API
using std::cout;
using std::endl;

// 将宽字符串转换为UTF-8字符串（使用Windows API）
std::string wstring_to_utf8(const std::wstring& wstr) {
    if (wstr.empty()) return "";
    
    // 计算需要的缓冲区大小
    int buffer_size = WideCharToMultiByte(
        CP_UTF8,           // 目标编码为UTF-8
        0,                 // 转换标志
        wstr.c_str(),      // 源宽字符串
        -1,                // 自动计算长度
        nullptr,           // 目标缓冲区（先不提供）
        0,                 // 目标缓冲区大小（先计算）
        nullptr,           // 无效字符替换（使用默认）
        nullptr            // 是否使用了替换字符
    );
    
    if (buffer_size <= 0) return "";
    
    // 分配缓冲区并进行转换
    std::string result(buffer_size, 0);
    WideCharToMultiByte(
        CP_UTF8,
        0,
        wstr.c_str(),
        -1,
        &result[0],
        buffer_size,
        nullptr,
        nullptr
    );
    
    // 移除结尾的空字符
    if (!result.empty() && result[result.size() - 1] == '\0') {
        result.pop_back();
    }
    
    return result;
}

extern "C" __declspec(dllexport) void sayHello(const char * s){
    cout<<"hello"<<s<<endl;
}

extern "C" __declspec(dllexport) void sayHelloW(const wchar_t* s) {
    if (s == nullptr) return; // 空指针保护
        try {
        // 将宽字符转换为UTF-8再输出，避免直接使用wcout的问题
        std::wstring wstr(s);
        std::string utf8_str = wstring_to_utf8(wstr);
        cout << "Hello, " << utf8_str << endl;
    } catch (...) {
        cout << "Error processing string" << endl;
    }
}
```
这里给了两个函数，分别用于处理简单的ascii字符串和 带中文的
通过命令行
```shell
    g++ -shared -o mylib.dll hello.cc   
```
将其处理为 dll 文件

## go 部分
这里是展示两种加载和 字符串处理方式：
    - lazy 加载，调用到对应函数时才会第一次加载，有助于优化启动速度，实现热更新要用系统调用释放这部分，再加载
    - loaddll 调用这个方法时加载，需要手动释放，实现热更新时，释放再加载就行
```go
import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// 将Go字符串转换为C兼容的UTF-8字符串
func cString(s string) *byte {
	b := make([]byte, len(s)+1)
	copy(b, s)
	return &b[0]
}

func lazydllW() {
	// 加载动态库
	lib := windows.NewLazyDLL("mylib.dll")

	if err := lib.Load(); err != nil {
		fmt.Println("加载动态库失败:", err)
		return
	}

	// defer lib.Release()
	// 获取函数地址
	funcAddr := lib.NewProc("sayHelloW")

	// 调用函数
	exampleFunction := funcAddr.Addr()
	str, err := syscall.UTF16PtrFromString("潘达") // 使用宽字符串
	if err != nil {
		fmt.Println("Error converting string:", err)
		return
	}
	_, _, err = syscall.SyscallN(exampleFunction, uintptr(unsafe.Pointer(str)))
	if err != syscall.Errno(0) {
		fmt.Println("Error calling Add:", err)
		return
	}
	fmt.Println("函数执行成功")
}

func loadWithASCII(){
    	// 加载动态库
	lib, err := syscall.LoadDLL("mylib.dll")

	if err != nil {
		fmt.Println("加载动态库失败:", err)
		return
	}

	defer lib.Release() // 非lazy模式记得手动释放
	// 获取函数地址
	funcAddr, err := lib.FindProc("sayHello")
	if err != nil {
		fmt.Println("函数查找失败:", err)
		return
	}
	// 调用函数
	exampleFunction := funcAddr.Addr()
	str := "panda"
	cStr := unsafe.Pointer(cString(str)) // 注意这里，需要转成c 兼容的字符串，类型转成Pointer
	if err != nil {
		fmt.Println("Error converting string:", err)
		return
	}
	_, _, err = syscall.SyscallN(exampleFunction, uintptr(cStr))
	if err != syscall.Errno(0) {
		fmt.Println("Error calling Add:", err)
		return
	}
	fmt.Println("函数执行成功")
}

```