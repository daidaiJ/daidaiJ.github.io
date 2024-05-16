# 一个range 风格的范围迭代器封装实现
------
go 里面有个range 的表达式可以遍历很多容器，最近应该是1.21支持range int,这看起来很像 python的 range 了，很舒服，想着很久没用cpp 写东西了就准备按照迭代器整一个，做小点，也不用什么模板；
## 第一种宏定义
这种其实类似 哪些OIer 常用的 for_each 宏

```cpp
    #define rangeI(_I, _end) for (i = 0; i < (_end); i++)
```
其实就是一个包装常见的 for 表达式头的一个宏，限制挺多，优点是几乎零开销；
## 迭代器类封装实现
这个东西实现上并未考虑太多性能,应该会需要创建两个对象，
```cpp


class RangeIter {
  private:
  int step;
  int cur_val;

  public:
  RangeIter(int step, int val) : step(step), cur_val(val) {}

  // these three methods form the basis of an iterator for use with a rangeIter-based for loop
  bool operator!=(const RangeIter &other) const {
    if (step < 0) {
      return cur_val != other.cur_val && cur_val > other.cur_val;
    }
    return cur_val != other.cur_val && cur_val < other.cur_val;
  }

  // this method must be defined after the definition of IntVector since it needs to use it
  int operator*() const { return cur_val; }
  const RangeIter &operator++() {
    cur_val += step;
    return *this;
  }
};
class Range {
  private:
  int _st, _end, _step;
  bool args_check() const {
    if (_step == 0) {
      return false;
    }
    if (_step < 0 && _st <= _end) {
      return false;
    }
    return _step <= 0 || _st < _end;
  }

  public:
  Range(int start, int end, int step) : _st(start), _end(end), _step(step) {}
  Range(int start, int end) : _st(start), _end(end), _step(1) {}
  explicit Range(int end) : _st(0), _end(end), _step(1) {}
  RangeIter iter() { return RangeIter{_step, _st}; }
  RangeIter cbegin() const {
    if (!args_check()) {
      throw std::invalid_argument("step should match the exper start+n*step>end");
    }
    return RangeIter{_step, _st};
  }
  RangeIter cend() const {
    // if (!args_check()){
    //     throw std::invalid_argument("step should match the exper start+n*step>end");
    // }
    return RangeIter{_step, _end};
  }
  RangeIter begin() {
    if (!args_check()) {
      throw std::invalid_argument("step should match the exper start+n*step>end");
    }
    return RangeIter{_step, _st};
  }
  RangeIter end() { return RangeIter{_step, _end}; }
};
```
这里对 begin 做了参数检查，避免意外的错误情况，导致无限循环之类的情况，其实正常情况应该是把RangeIter 这个迭代器实现给塞到 private 域里面去，避免他人骚操作；但这里只是一个简单的演示demo就不用考虑太多；
## 调用

```cpp
int main() {
  std::vector<int> val{1, 2, 3};
  int i = 0;
  rangeI(i, val.size()) { std::cout << val[i] << std::endl; }
  // 1
  // 2
  // 3
  try {
    for (auto i : Range(static_cast<int>(val.size()), 0, -1)) {
      std::cout << i << ";\n";
    }
  } catch (std::logic_error &e) {
    std::cout << "error" << e.what() << std::endl;
  }
  // 3;
  // 2;
  // 1;
  std::cout << std::endl;
}

```
总之复习了for range和迭代器实现