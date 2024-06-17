# 进程崩溃
----
## 系统转储
- windows 上开启`Windows Error Reporting Service` 配置捕获特定进程的dump 数据
- linux 上检查 `ulimit -c` 返回的核心转储文件大小限制，使其是一个大于零的数字，使用gdb -c 恢复coredump 
- bt 打印队长

## 信号打印堆栈

SIGSEGV和SIGABRT信号
```cpp
void sigHandler(int signo) 
{
	LOG_ERROR_ARGS("=====recv SIGINT %d=====", signo);
	
	//打印错误堆栈信息
	LOG_ERROR("----------------------------Dump Program Error Strings-------------------------");
	int j = 0, nptrs = 0;
 	void* buffer[100] = { NULL };
 	char** strings = NULL;
 	nptrs = backtrace(buffer, 100);
 	LOG_ERROR_ARGS("backtrace() returned %d addresses", nptrs);
 	strings = backtrace_symbols(buffer, nptrs);
 	if (strings == NULL) {
  		LOG_ERROR("backtrace_symbols null");
  		LOG_ERROR("-------------------------------------------------------------------------------");
  		return;
 	}
 	for (j = 0; j < nptrs; j++) {
  		LOG_ERROR_ARGS("  [%02d] %s", j, strings[j]);
 	}
 	free(strings);
	LOG_ERROR("-------------------------------------------------------------------------------");
	
	//恢复默认信号操作
	signal(signo, SIG_DFL);
  	raise(signo);
}

```
## 系统日志
journalctl 和coredumpctl 两个开日志来排查