---
title: "矢量化扩展"
description: 
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
    - 性能优化
    - cpp
---
# 矢量化扩展
-----
##
```cpp
#include <array>
#include <chrono>
#include <iostream>
#include <string>
#include <vector>
#include "boost/core/noncopyable.hpp"

using std::chrono::duration_cast;
using std::chrono::high_resolution_clock;
class BenchTimer : boost::noncopyable {
  high_resolution_clock::time_point tp;
  std::string name;
  std::vector<std::string> rd;
  std::vector<double> dt;

  public:
  inline void st(const std::string &name) {
    this->name = name;
    tp = high_resolution_clock::now();
  }
  inline void end() {
    dt.emplace_back(duration_cast<std::chrono::nanoseconds>(high_resolution_clock::now() - tp).count());
    rd.emplace_back(this->name);
  }
  void showBenchTest() {
    for (int i = 0, size = static_cast<int>(rd.size()); i < size; i++) {
      std::cout << rd[i] << ":" << dt[i] / 1000 << "\n";
    }
  }
};

int main() {
  std::vector<int> arr_a(256, 0);
  std::vector<int> arr_b(256, 100);
  typedef int int256 __attribute__((vector_size(256 * sizeof(int))));
  int256 a;
  int256 b;

  for (int i = 0; i < 256; i++) {
    arr_a[i] = i;
    a[i] = i;
    arr_b[i] = 256 - i;
    b[i] = 256 - i;
  }
  int t = 10000;
  auto bench = BenchTimer();
  #pragma clang optimize off
  bench.st("foreach");
  while (t > 0) {
    for (auto i = 0; i < 256; i++) {
      arr_a[i] = 2 * arr_b[i];
    }
    t--;
  }
  bench.end();
  t = 10000;
  bench.st("vec");
  while (t > 0) {
    a = 2 * b;
    t--;
  }
  bench.end();
  #pragma clang optimize on
  bench.showBenchTest();
  std::cout << "2*b[0]==" << a[0] << std::endl;
}
```

## bench测试结果
foreach:673.4
vec:4.8      
2*b[0]==512  

按照600/5 也有120倍的加速差距了，据我观察这种大轮次的外部循环可能对vec 的缓存hit更友好点，总之是有优化效果的