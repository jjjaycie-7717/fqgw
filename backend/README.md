# 后端说明（飞书多维表格版）

## 当前策略
- 不再使用本地数据库
- 表单数据提交后，直接写入飞书多维表格
- 前端接口保持不变：
  - `POST /api/leads/consultation`
  - `POST /api/leads/phone`

## 依赖
- Node.js 20+

## 启动前配置环境变量
在启动命令前设置（示例）：

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export FEISHU_APP_TOKEN=bascnxxx
export FEISHU_CONSULTATION_TABLE_ID=tblxxx
export FEISHU_PHONE_TABLE_ID=tblyyy
export CONSULTATION_ARTICLE_LINKS=https://mp.weixin.qq.com/s/xxx,https://mp.weixin.qq.com/s/yyy
export CONSULTATION_MAX_ITEMS=9
```

说明：
- 如果咨询和手机号都写到同一个表，也可以只设置：
  - `FEISHU_TABLE_ID=tblxxx`
- 此时 `FEISHU_CONSULTATION_TABLE_ID` 和 `FEISHU_PHONE_TABLE_ID` 可不填
- 资讯同步可选参数：
  - `CONSULTATION_ARTICLE_LINKS`：公众号文章链接列表（逗号分隔）
  - `CONSULTATION_MAX_ITEMS`：对外返回的最大文章数（默认 9）

## 飞书多维表格字段建议
请在目标表中创建这些列（字段名要一致）：
- `提交ID`（文本）
- `线索类型`（文本）
- `姓名`（文本）
- `手机号`（文本）
- `意向产品`（文本）
- `提交时间`（日期；后端写入毫秒时间戳）

## 启动
在项目根目录执行：

```bash
node backend/server.js
```

## 验证
1. 健康检查：

```text
http://localhost:3000/api/health
```

如果 `feishuConfigured` 是 `true`，说明环境变量配置齐了。

2. 打开页面并提交表单：

```text
http://localhost:3000/index.html
```

3. 去飞书多维表格看新增行。

4. 查看自动同步的资讯接口：

```text
http://localhost:3000/api/consultation/articles
```

## 防护策略（仍保留）
- 限流：同一 IP 对提交接口 1 分钟最多 12 次
- 重复提交拦截：10 分钟内同一线索返回 `409`
  - 立即咨询：手机号 + 页面来源（内部字段）+ 意向产品集合
  - 预约回电：手机号 + 来源标记（内部字段）

## 说明
- `GET /api/leads` 和 `GET /api/admin/*` 现在会返回 `410`，提示到飞书查看数据。
