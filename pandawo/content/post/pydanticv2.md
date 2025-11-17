---
title: "pydantic V2 迁移遇到的json 类型兼容问题"
slug: "一如既往"
description: "记录三种json 转换方案"
date: 2025-10-17T13:38:40+08:00
lastmod: 2025-10-17T13:38:40+08:00
draft: false
toc: true
hidden: false
weight: false
musicid: 5264842
qqmusic: 
categories: ["python"]
tags: ["python"]
image: https://picsum.photos/seed/8e16cae4/800/600
---

# pydantic v2 的json 兼容性问题
---
> 背景介绍： 项目里面有很多v1 时代的写法，例如：`envs: List[EnvModel] = Field([], sa_column=Column(JSON), description="环境变量列表")`, 在v1 时代pydantic 会自动帮你做泛型转换
在 Pydantic v1 中，可能通过隐式逻辑将 List[T] 与 JSON 类型关联，但 v2 移除了这种隐式关联，导致直接使用 sa_column=Column(JSON) 时，SQLAlchemy 无法将 List[EnvModel] 与 JSON 类型正确绑定，从而会引发报错` <class 'list'> has no matching SQLAlchemy type`。本质原因是SQLAlchemy 对字段类型的推断依赖于明确的 Python 类型与数据库类型的映射（如 str → VARCHAR，int → INTEGER）。但对于泛型容器类型（如 List[EnvModel]），SQLAlchemy 本身无法直接识别为某个数据库类型（如 JSON），必须显式指定类型（如 Column(JSON)）。  

现在介绍三种解决方法：
## 方案1 手动添加方法进行转换
```python
class EnvModel(SQLModel):
    name: str = Field(..., nullable=False)
    value: str = Field(..., nullable=False)

env_list_adapter = TypeAdapter(list[EnvModel])

class APP(SQLModel, table=True):
    __tablename__ = "apps"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field("应用名称", nullable=False, description="应用名称")
    envs_json: str = Field("",sa_column=Column(JSON),alias="envs")
    def __init__(self,**data:Any):
        envs_ = data.pop("envs",None)
        super().__init__(**data)
        if isinstance(envs_,list):
            self.envs = envs_
                    
    @property
    def envs(self)->list[EnvModel]:
        if isinstance(self.envs_json,str) and self.envs_json:
            try:
                return env_list_adapter.validate_json(self.envs_json)
            except Exception:
                return []
        return env_list_adapter.validate_python(self.envs_json)
    
    @envs.setter
    def envs(self,val:list[EnvModel]):
        self.envs_json = env_list_adapter.dump_json(val).decode()
```
优点： 简单易懂，简单类转换一下也不会出啥问题  
缺点： 改动较多，一个字段最少得多两个方法和一个TypeAdapter，在大量使用这种复合类型字段的情况下，这种改动太多了

## 方案2 减少对类的改动，通过外部转换
```python
class EnvModel(SQLModel):
    name: str = Field(..., nullable=False)
    value: str = Field(..., nullable=False)
    class Config:
        orm_mode = True
        
class APP(SQLModel, table=True):
    __tablename__ = "apps"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field("应用名称", nullable=False, description="应用名称")
    # 这里用list[dict] 字典列表来做类型注解，自动转换为常见的array json类型
    envs: list[dict] = Field( sa_column=Column(ARRAY(JSON)),alias="envs") 
```
优点： 对类几乎无改动，用的也是基本类型字典  
缺点： 如下：
```python
async with async_session() as session:
    try:
        test = APP(
            name="测试服务",
            envs=[
                    # 赋值需要转成dict 
                    EnvModel(name="PATH", value="/usr/local/bin").model_dump(),
                    EnvModel(name="PYTHONPATH", value="/app").model_dump(),
                    EnvModel(name="DEBUG", value="true").model_dump()
                ]
            )

        session.add(test)
        await session.commit()
        await session.refresh(test)

        logger.info(f"创建的服务 ID: {test.id}")
        logger.info(f"环境变量数量: {len(test.envs)}")

        result = await session.execute(select(APP).where(APP.id == test.id))
        db_app = result.first()

        logger.info(f"查询到的服务名称: {db_app.name}")
        logger.info("环境变量:")
        for env in db_app.envs:
            # 获取时需要用EnvModel 来检验类型，并转换成对应实例
            env = EnvModel(**env)
            logger.info(f"  {env.name}: {env.value}")

```

## 方案3 自定义类型适配器，推荐
```python
T = TypeVar('T', bound=SQLModel)


class SQLModelListType(TypeDecorator, Generic[T]):
    """
    自定义SQLAlchemy类型，自动处理：
    - 写入：list[SQLModel] -> list[dict]（存储为JSON数组）
    - 读取：list[dict] -> list[SQLModel]
    """
    # 基础类型：PostgreSQL的ARRAY(JSON)或纯JSON
    impl = JSON  # 若用纯JSON则改为JSON

    def __init__(self, model_cls: Optional[Type[T]]=None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if model_cls:
            self.model_cls: Type[T] = model_cls  # 明确标注类型

    def process_bind_param(self, value: List[T], dialect) -> List[dict]:
        """写入数据库时：将模型列表转为字典列表"""
        if not value:
            return []
        return [item.model_dump() for item in value]

    def process_result_value(self, value: List[dict], dialect) -> List[T]:
        """从数据库读取时：将字典列表转为模型列表"""
        if not value:
            return []
        return [self.model_cls(** item) for item in value]


class EnvModel(SQLModel):
    name: str = Field(..., nullable=False)
    value: str = Field(..., nullable=False)



class APP(SQLModel, table=True):
    __tablename__ = "apps"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field("应用名称", nullable=False, description="应用名称")
    # 核心改动：使用自定义类型，指定模型类型为EnvModel
    envs: list[EnvModel] = Field(
        default_factory=list,
        sa_column=Column(SQLModelListType(EnvModel))  # 绑定自定义类型
    )
```
优点： 能复用这个类型装饰器，实现v2 的类型迁移，几乎无感，改动也仅限于对应字段的那行，完全可以接受这个工作量  
缺点： 自定义sqlalchemy 类型装饰器的场景比较少见，用来做sa_column 可能没之前那么直白，理解难度会高一些

###  sqlalchemy 的类型装饰器

SQLAlchemy 的 TypeDecorator 是用于自定义数据库类型的核心工具，它通过封装底层数据库类型并覆盖特定方法，实现 Python 类型与数据库类型的双向转换。其核心方法如下：
1. impl：指定底层数据库类型（必须定义）  
impl 是 TypeDecorator 的核心类属性，用于指定当前自定义类型基于哪个 SQLAlchemy 原生类型（如 Integer、String、JSON 等）。所有数据库交互最终会委托给这个底层类型。  
**示例**：

    ```python
    from sqlalchemy import TypeDecorator, JSON

    class MyJsonType(TypeDecorator):
        impl = JSON  # 基于原生 JSON 类型扩展
    ```
2. process_bind_param(self, value, dialect)：Python → 数据库（写入时）  
作用：将 Python 中的值（如自定义对象、复杂类型）转换为底层数据库类型可接受的格式（如 JSON 类型接受字典 / 列表，String 接受字符串）。  
参数:
   - value：Python 中要写入数据库的值（可能为 None）。
   - dialect：当前数据库方言（如 postgresql、mysql），可用于适配不同数据库的差异。
   - 返回值：转换后的值（需符合 impl 类型的要求）。  
 
    **示例**：
    ```python
    def process_bind_param(self, value, dialect):
        if value is None:
            return []
        # 将自定义模型列表转为字典列表（适配 JSON 类型）
        return [item.dict() for item in value]
    ```
1. process_result_value(self, value, dialect)：数据库 → Python（读取时）  
作用：将从数据库读取的值（如 JSON 解析后的字典）转换为 Python 中需要的类型（如自定义模型、复杂对象）。  
参数：
- value：从数据库读取的值（可能为 None，格式由 impl 类型决定）。
- dialect：当前数据库方言。
- 返回值：转换后的 Python 对象（如自定义模型实例）。  
    **示例**：
    ```python

    def process_result_value(self, value, dialect):
        if not value:
            return []
        # 将字典列表转为自定义模型列表
        return [MyModel(** item) for item in value]
    ```
4. process_literal_param(self, value, dialect)：处理 SQL 字面量（可选）  
作用：当值以字面量形式嵌入 SQL 语句（如 INSERT VALUES (?) 中的 ?）时，将其转换为符合 SQL 语法的字符串。  
默认行为：若未实现，会使用 impl 类型的 process_literal_param 方法。
通常用于自定义类型需要特殊 SQL 字面量格式的场景（如日期格式化）。  
    **示例**：
    ```python
    def process_literal_param(self, value, dialect):
        if value is None:
            return 'NULL'
        # 对字符串类型值添加单引号，避免 SQL 注入风险
        return f"'{value}'"
    ```

