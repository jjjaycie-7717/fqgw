# 后端入门（本项目）

## 你现在有了什么
- 一个 Node.js 原生后端：`backend/server.js`
- 线索数据主存储：`backend/data/leads.db`（SQLite）
- JSON 备份文件：`backend/data/leads.json`（首次启动会自动迁移到 SQLite）
- 前端和后端由同一个服务提供，避免跨域问题

## 第一步：启动后端
在项目根目录执行：

```bash
node backend/server.js
```

看到 `Server running at http://localhost:3000` 就代表成功。

说明：后端会调用系统 `sqlite3` 命令，请先确认本机可执行 `sqlite3 --version`。

## 第二步：打开前端
浏览器访问：

```text
http://localhost:3000/index.html
```

不要再直接双击 html 文件（`file://`），否则无法正确调用 API。

## 第三步：验证 API 是否可用
浏览器打开：

```text
http://localhost:3000/api/health
```

返回 `{"ok":true,...}` 就是后端正常。

## 第四步：查看提交的数据
你在页面提交表单后，打开：

```text
http://localhost:3000/api/leads
```

可以看到最新保存的咨询和手机号线索。

## SQLite 升级说明
- 后端已从 JSON 主存储升级为 SQLite
- 第一次启动时：如果 `leads.db` 还是空库，会自动读取 `leads.json` 并导入
- 导入后新数据写入 SQLite；`leads.json` 作为历史备份保留

## 当前接口
- `POST /api/leads/consultation`：提交“姓名 + 手机号 + 意向产品”
- `POST /api/leads/phone`：提交“手机号”
- `GET /api/leads`：查看保存结果（学习阶段用）
- `GET /api/health`：健康检查

## 新增防护（第 1 阶段）
- 重复提交拦截：10 分钟内相同线索会返回 `409`
- 接口限流：同一 IP 对单个提交接口 1 分钟最多 12 次，超出返回 `429`

## 管理接口（第 3 阶段）
- `GET /api/admin/leads/consultations`：查询咨询线索（支持筛选 + 分页）
- `GET /api/admin/leads/phones`：查询手机号线索（支持筛选 + 分页）
- `GET /api/admin/leads/summary`：查询汇总统计（总量、今日新增、来源分布、产品分布）

### consultations 查询参数
- `page`：页码，默认 `1`
- `pageSize`：每页条数，默认 `20`，最大 `100`
- `phone`：按手机号模糊筛选
- `name`：按姓名模糊筛选
- `sourcePage`：按来源页面模糊筛选
- `product`：按意向产品精确筛选（单个产品）
- `startAt` / `endAt`：按创建时间筛选（ISO 时间格式）

示例：

```text
http://localhost:3000/api/admin/leads/consultations?page=1&pageSize=10&sourcePage=%2Findex.html&product=蜂桥创作
```

### phones 查询参数
- `page`：页码，默认 `1`
- `pageSize`：每页条数，默认 `20`，最大 `100`
- `phone`：按手机号模糊筛选
- `source`：按来源标识模糊筛选
- `startAt` / `endAt`：按创建时间筛选（ISO 时间格式）

示例：

```text
http://localhost:3000/api/admin/leads/phones?page=1&pageSize=10&source=index-cta
```

### summary 示例

```text
http://localhost:3000/api/admin/leads/summary
```
