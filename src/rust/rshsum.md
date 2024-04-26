# rhksum 生成校验和的cli 工具
------
> 标签： rust  md5  sha1  crc32
>
> [源码仓库连接](https://gitee.com/adamszhang/rust-util/blob/master/rhksum)
## 简单的功能设计和使用说明
首先rhksum 定位是能够容忍将校验和指定输出到文件，或者控制台上，所以对原先设想的base64 编解码做了舍弃；因为base64的长度是随输入内容变动的，所以如果指定一个大文件然后将编码的结构打印到控制台上，体验会非常糟糕，同时和其他三个生成编码的算法不相对称，base64 是可以从编码上恢复的，同时没有校验功能，所以没有嵌入这部分。
```shell
rhksum -e crc32|md5|sha1 /
       -f  path/to/file  /
       -o  the out file  /
       -h help 
```
因为是一个命令行工具，所以一定是要能够支持管道符重定向输入的，所以在未指定文件时会自行推测从 stdin 开始获取。但是为了避免手动输入的滑稽场景，在检测到标准输入来源不是管道符就会退出，提前终止，避免需要手动触发退出；

## 命令行解析
这部分用的是 clap 的 builder 模式，需要在使用 `cargo add clap --feature cargo` 来使部分功能生效；
```rust
// 配置命令行参数选项
  let matches = command!()
        .arg(
            arg!(-'e' --"encode" <encode> "set the encode format")
                .required(false) // 传入 false 可以使这个 参数变成可选的
                .value_parser(["crc32", "md5", "sha1"]),
        )
        .arg(
            arg!(-'f' --"file" <file>  "set the input file")
                .required(false)
                .value_parser(clap::builder::NonEmptyStringValueParser::new()),
        )
        .arg(arg!(-'o' --"output" <output> "set the out put file").required(false))
        .get_matches();

// 解析命令行参数
    // 先声明四个变量，分别应对标准io 和 文件io
    let mut ifile: File;
    let mut ofile: File;
    let mut stdin = stdin();
    let mut stdout = stdout();

    let f = matches.get_one::<String>("file");
    let o = matches.get_one::<String>("output");
    // 这个 e 是编码格式的选项
    let e = matches
        .get_one::<String>("encode")
        .expect("parser encode format failed");
    // 通过 io::Write  io::Read 这两个Traits 用来做动态类型，让各个mod 的方法在签名上统一
    let dest: &mut dyn io::Write = match o {
        None => &mut stdout,
        Some(ref a) => {
            ofile = File::create(a).expect("output file open failed");
            &mut ofile
        }
    };
    let src: &mut dyn io::Read = match f {
        None => {
            // 未指定输入文件的时候，主动检测标准输入是不是终端，是的话提前失败退出
            if stdin.is_terminal() {
                println!("dont support input by manual type");
                return;
            }
            &mut stdin
        }
        Some(ref a) => {
            ifile = File::open(a).unwrap();
            &mut ifile
        }
    };

```
## 模式匹配
```rust 
    // 这部分要写的这么难看就是  
    // rust 会认为 &std::string::String 和 &str 不是一个类型，需要主动去转换；
    match &e as &str {
       
       "crc32" => crc32_::encode(&mut *src, &mut *dest),
        "md5" => md5::encode(&mut *src, &mut *dest),
        "sha1" => sha1::encode(&mut *src, &mut *dest),
        _ => {}    // 未匹配路径这里旧直接退出了，
        // 其实这个逻辑 分支会在命令行输入出被校验出来提前失败,所以这里不处理是可以的
    }
```

## 校验加密算法

这里三个mod 模块都是公开的，可以被作为库嵌入使用
```rust
pub mod crc32_ {
    use crc::{Crc, CRC_32_ISO_HDLC};
    use std::{io::Read, io::Write};
    pub fn encode(r: &mut dyn Read, w: &mut dyn Write) {
        let crc = Crc::<u32>::new(&CRC_32_ISO_HDLC);
        let mut digest = crc.digest();
        let mut v = [0u8; 1024];
        loop {
            let cnt = r.read(&mut v[..]).unwrap();
            if cnt == 0 {
                break;
            }
            digest.update(&mut v[..cnt])
        }
        let checksum = format!("{0:<8X}\n", digest.finalize()); // 大写的十六进制输出下32/4 最后有8位字符，通过0左填充以防长度问题
        // println!("result is {0:8}", checksum);
        let re = w.write(checksum.as_bytes());
        if re.is_err() {
            println!("err is {:#} ", re.expect_err("write error"))
        }
    }
}

pub mod md5 {
    use chksum_md5 as md5;
    use std::{io::Read, io::Write};
    pub fn encode(r: &mut dyn Read, w: &mut dyn Write) {
        let mut f = md5::reader::new(r);
        let mut buffer = Vec::new();
        f.read_to_end(&mut buffer).unwrap();
        let digest = f.digest();
        let checksum = format!("{}\n", digest.to_string().to_uppercase());
        // println!("result is {}", checksum);
        let re = w.write(checksum.as_bytes());
        if re.is_err() {
            println!("err is {:#} ", re.expect_err("write error"))
        }
    }
}

pub mod sha1 {
    use sha1_smol::Sha1 as sha1;
    use std::{io::Read, io::Write};
    pub fn encode(r: &mut dyn Read, w: &mut dyn Write) {
        let mut digest = sha1::new();
        let mut v = [0u8; 1024];
        loop {
            let cnt = r.read(&mut v[..]).unwrap();
            if cnt == 0 {
                break;
            }
            digest.update(&mut v[..cnt])
        }
        let checksum = format!("{}\n", digest.digest().to_string().to_ascii_uppercase());
        // println!("result is {}", checksum);
        let re = w.write(checksum.as_bytes());
        if re.is_err() {
            println!("err is {:#} ", re.expect_err("write error"))
        }
    }
}


```
这部分其实做的工作不多，但是这几个库的调用形式是有差异的，为了统一函数签名，还是花了些时间
