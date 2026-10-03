# Media Garden API 文档

本文描述当前项目的 HTTP API，依据 `server/app.ts`、`shared/types.ts` 及对应服务实现编写。默认服务地址为 `http://localhost:3210`，以下路径均包含 `/api` 前缀。

## 1. 通用约定

- 请求与响应使用 JSON，媒体下载接口返回二进制。发送 JSON 时设置 `Content-Type: application/json`。
- 请求体最大为 16,384 字节（16 KiB），超出返回 413；图片翻译提交媒体 ID，不上传图片。
- `id`、`assetId`、缓存 `key` 均应作为不透明标识使用。放入 URL 路径时用 `encodeURIComponent` 编码。
- 时间戳字段（如 `modified`、`updated`、`createdAt`、`startedAt`）为 Unix 毫秒；`elapsed`、`timeoutMs` 的单位也是毫秒。作品 `date` 是日期字符串，不保证总带有时分秒。
- 文档中的示例 ID 为占位值，实际调用先从目录、作品或任务响应中取得 ID。
- GET 路由由 Fastify 默认提供对应 HEAD 路由；HEAD 返回响应头，不返回正文。
- API 没有账号、登录态或独立 API Token 校验。AI 配置中的 `apiKey` 是服务端请求上游供应商使用的凭据。

### 1.1 访问限制

默认仅接受局域网与保留地址：IPv4 的 `10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`100.64/10`、`198.18/15`，以及 IPv6 回环、`fc00::/7`、`fe80::/10`。实现也接受 IPv6 的 `::`；IPv4 映射地址按内层 IPv4 判断。

带有非空 `X-Forwarded-For`、`X-Real-IP` 或 `Forwarded` 头的请求也会被拒绝。设置环境变量 `ALLOW_PUBLIC_ACCESS=1`（也接受 `true`、`yes`、`on`）并重启可解除上述来源限制。

对于 GET、HEAD、OPTIONS 以外的方法，以下情况返回 403：

- `Sec-Fetch-Site: cross-site`。
- 存在 `Origin` 且其 host（包含端口）与请求 `Host` 不同。

服务未配置跨域 CORS 放行。浏览器客户端应同源访问；开发模式可使用 Vite 的 `/api` 代理。所有响应设置 `X-Content-Type-Options: nosniff` 与 `Referrer-Policy: same-origin`。

### 1.2 错误格式与状态码

业务错误和统一错误处理器通常返回：

```json
{ "message": "作品不存在" }
```

| 状态码 | 含义 |
| --- | --- |
| 200 | 请求成功；任务接口还需检查响应中的业务状态 |
| 201 | 媒体目录已创建 |
| 202 | 扫描已触发或转码请求已处理，需继续查询状态 |
| 206 | 返回请求的单段媒体字节范围 |
| 304 | ETag 命中，无正文 |
| 400 | 参数、目录路径、AI 配置或媒体类型不符合要求；部分上游错误也映射到此状态 |
| 403 | 来源受限、跨站写入或目录权限不足 |
| 404 | 对象、文件、任务或缓存不存在 |
| 409 | 扫描进行中或目录重复 |
| 413 | 请求体超过大小限制 |
| 416 | 无效或不可满足的 Range，无 JSON 正文 |
| 500 | 未分类的服务端异常 |
| 502 | AI 上游连接失败、上游 5xx 或返回内容不符合要求 |
| 503 | 暂时无法浏览目录 |
| 504 | AI 请求超时 |

未知路由的 404 格式可能受是否存在前端构建产物影响，不应依赖具体文案。AI 上游 401、403、404、429 等非 5xx 错误会映射为本服务的 400，原始状态体现在 `message` 中。

## 2. 路由总览

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/api/status` | 媒体库、扫描及网络状态 |
| POST | `/api/scan` | 触发扫描 |
| GET | `/api/directories` | 浏览服务端目录 |
| POST | `/api/sources` | 添加媒体来源 |
| PUT | `/api/sources/:id` | 修改媒体来源 |
| DELETE | `/api/sources/:id` | 移除媒体来源 |
| GET | `/api/tags` | 标签建议 |
| GET | `/api/works` | 搜索、筛选和分页查询作品 |
| GET | `/api/works/:id` | 作品详情与媒体列表 |
| PUT | `/api/works/:id/favorite` | 设置收藏状态 |
| GET | `/api/assets/:id/file` | 原始媒体 |
| GET | `/api/assets/:id/thumbnail` | 缩略图 |
| POST | `/api/assets/:id/convert` | 请求生成兼容视频 |
| GET | `/api/assets/:id/convert` | 转码状态 |
| GET | `/api/assets/:id/compatible` | 兼容视频 |
| GET | `/api/ai/settings` | 读取 AI 配置 |
| PUT | `/api/ai/settings` | 保存 AI 配置 |
| POST | `/api/ai/test` | 测试 AI 连接 |
| POST | `/api/ai/models` | 获取上游模型列表 |
| DELETE | `/api/ai/cache` | 清空作品信息翻译缓存 |
| POST | `/api/ai/translate` | 翻译作品信息 |
| GET | `/api/ai/manga/status` | 本地漫画模型状态 |
| POST | `/api/ai/manga/translate` | 创建漫画翻译任务 |
| GET | `/api/ai/manga/jobs/:id` | 查询漫画任务 |
| GET | `/api/ai/manga/cache/:key/base.png` | 漫画擦字底图 |

## 3. 公共数据结构

### 3.1 Source：媒体来源

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 服务端生成的 UUID |
| name | string | 显示名称 |
| kind | `pixiv` / `telegram` | 文件命名与分组规则 |
| path | string | 服务端实际目录的绝对路径 |

### 3.2 Work：作品列表项

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 作品标识 |
| sourceId / sourceName | string | 所属媒体来源 ID / 名称 |
| sourceKind | `pixiv` / `telegram` | 来源类型 |
| externalId | string | 从命名规则提取的外部作品编号 |
| title / author / description | string | 标题、作者、简介，可能为空或使用回退标题 |
| tags | string[] | 标签 |
| date | string | 发布日期，缺失元数据时由扫描器推导 |
| collected | number | 文件名中的收藏编号或消息号，不是时间戳 |
| updated | number | 相关文件最新修改时间 |
| count | number | 分组中用于展示的媒体数量 |
| kind | `image` / `video` / `animation` | 作品媒体类型 |
| favorite | boolean | 整组收藏状态 |
| cover | string | 缩略图相对 URL，含缓存版本查询参数 |
| approximate | boolean，可选 | 是否包含模糊匹配；列表接口提供此字段 |

### 3.3 Asset：作品内媒体

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id / workId | string | 媒体 ID / 所属作品 ID |
| filename | string | 文件名 |
| page | number | 文件名解析出的页码，可能从 0 开始，不等同于 UI 页序 |
| kind | `image` / `video` / `animation` | 媒体类型 |
| extension | string | 小写扩展名，不含点 |
| size | number | 字节数 |
| modified | number | 文件修改时间 |
| url / thumbnail | string | 原文件 / 缩略图相对 URL |

媒体响应不暴露文件的绝对路径。作品详情仅包含用于展示的媒体项，重复导出的同页可能被折叠。

## 4. 媒体库与目录

### 4.1 GET /api/status

无需参数，200 返回：

```json
{
  "works": 120,
  "files": 480,
  "favorites": 12,
  "images": 100,
  "videos": 15,
  "animations": 5,
  "sources": [
    { "id": "source-id", "name": "插画", "kind": "pixiv", "path": "E:\\Media\\Pixiv", "works": 120, "online": true }
  ],
  "scan": {
    "running": false,
    "phase": "媒体库已更新",
    "files": 510,
    "works": 120,
    "startedAt": 1791000000000,
    "finishedAt": 1791000003000,
    "errors": []
  },
  "ffmpeg": true,
  "addresses": ["http://192.168.1.10:3210"],
  "publicAccess": false
}
```

- `works`、`favorites`、`images`、`videos`、`animations` 按作品组计数。
- 顶层 `files` 是作品展示媒体数量之和；`scan.files` 是本轮扫描中识别到的文件数，可能包含元文件和重复项，二者不一定相等。
- `sources` 为 Source 数组，附加 `works` 和 `online`。
- `scan.startedAt`、`scan.finishedAt` 在尚未发生相应事件时为 null。`phase` 是展示文本，不作为稳定枚举；客户端以 `running` 判断扫描是否进行中，以 `errors` 判断部分失败。
- `ffmpeg` 表示服务启动检测时 FFmpeg 是否可用；`addresses` 来自非回环 IPv4 网卡地址和服务端口。

### 4.2 POST /api/scan

无需请求体。返回 202 和 ScanStatus（上例的 `scan` 对象），后台开始扫描；扫描中重复调用返回 409。

通过 GET `/api/status` 轮询 `scan.running` 和 `scan.errors`。扫描某目录失败时保留原索引；202 不表示扫描已完成。

### 4.3 GET /api/directories

| 查询参数 | 类型 | 说明 |
| --- | --- | --- |
| path | string，可选 | 服务端目录绝对路径，最长 4096 字符 |

不传 `path` 或传空字符串时，Windows 返回可访问盘符，其他平台返回 `/`。指定目录时只返回其直接子目录，按名称自然排序。

```json
{
  "path": "E:\\Media",
  "parent": "E:\\",
  "breadcrumbs": [
    { "name": "E:\\", "path": "E:\\" },
    { "name": "Media", "path": "E:\\Media" }
  ],
  "directories": [{ "name": "Pixiv", "path": "E:\\Media\\Pixiv" }]
}
```

根列表的 `path`、`parent` 为 null，`breadcrumbs` 为空；具体磁盘根目录的 `parent` 也为 null。响应含 `Cache-Control: no-store`。

错误：非法路径 400，权限不足 403，不存在或不是目录 404，其他读取失败 503。浏览的是服务所在电脑，与发请求设备的文件系统无关。

### 4.4 POST /api/sources

请求体：

```json
{ "name": "插画", "path": "E:\\Media\\Pixiv", "kind": "pixiv" }
```

三个字段均必填：`name` 长度 1–60，`path` 长度 1–2048，`kind` 为 `pixiv` 或 `telegram`。名称去除首尾空格后不能为空；路径必须为服务端可访问的绝对目录，服务端解析真实路径。

成功返回 201 和完整 Source，并自动触发扫描。错误包括 400（路径、名称不合法）、409（重复目录或扫描中）。Windows 下目录重复比较忽略大小写。

### 4.5 PUT /api/sources/:id

请求体与新增相同，三个字段均必填。200 返回更新后的 Source，保留原 `id`，并自动扫描。不存在返回 404；其他校验和扫描冲突规则与新增相同。

修改同一来源的路径会保留能够对应到原作品 ID 的收藏。

### 4.6 DELETE /api/sources/:id

无需请求体，成功 200：

```json
{ "ok": true }
```

删除来源配置以及该来源的作品索引、媒体索引、收藏记录，不删除原始媒体文件。扫描中返回 409，不存在返回 404。

来源列表通过 GET `/api/status` 的 `sources` 获取；没有单独的 GET `/api/sources`。

## 5. 作品与搜索

### 5.1 GET /api/works

| 查询参数 | 默认 | 说明 |
| --- | --- | --- |
| q | 空 | 最多使用前 500 字符、前 12 个有效搜索词 |
| source | 不限 | 按 Source ID 筛选 |
| kind | 不限 | `image`、`video`、`animation`，可逗号分隔，如 `video,animation` |
| favorites | 不限 | 仅字符串 `true` 启用只看收藏 |
| fuzzy | 关闭 | 仅字符串 `true` 启用模糊候选 |
| page | 1 | 每页固定 48 项；向下取整并限制在 1 到 pages 之间 |
| sort | 最新优先 | `newest`、`oldest`、`title`、`random`、`relevance` |
| by | 发布日期 | `collected` 使用收藏编号排序；其他值按发布日期 |
| seed | `0` | 随机排序种子；翻页时应保持一致 |

搜索词默认按空白分隔，所有词都要命中，可跨标题、作者、简介、标签和编号命中。支持简繁、全半角、大小写、拼音和首字母匹配。

`#风景` 是标签精确匹配，含空格的标签写为 `#"blue sky"`；标签词不参与错字模糊匹配。URL 中的 `#` 必须编码为 `%23`，建议用 `URLSearchParams` 构造查询。

排序规则：

- 只有非空 `q` 配合 `sort=relevance` 才保持相关度顺序。
- `by=collected` 只对时间排序有效，且筛选结果必须仅含一个来源，否则按发布日期排序。
- API 未指定 `by` 时按发布日期；前端默认偏好与 API 默认值并不相同。
- 未识别的 `sort` 值按最新优先处理；未知 `kind` 或 `source` 一般导致无匹配结果。
- 随机排序由 `seed` 与作品 ID 决定，数据集不变且种子相同时翻页顺序稳定。

200 返回：

```json
{ "items": [], "total": 0, "page": 1, "pages": 1, "elapsed": 1 }
```

`items` 为 Work 数组，`total` 为筛选后总数，`pages` 最小为 1，`elapsed` 是服务端本次查询处理耗时。

示例：`/api/works?kind=video,animation&favorites=true&page=1&sort=newest&by=collected&source=source-id`。

### 5.2 GET /api/tags

`q` 可选，最长 500 字符；可包含开头的 `#`。按匹配程度、标签计数和名称排序，支持部分文字及拼音；无关键词时优先返回计数较高的标签。

200 返回最多 12 项，`total` 是全部匹配标签数：

```json
{ "items": [{ "name": "风景", "count": 18 }], "total": 1 }
```

`count` 为索引中的标签计数；此接口没有按来源或收藏筛选参数。响应含 `Cache-Control: no-store`。

### 5.3 GET /api/works/:id

200 返回 Work 的全部基础字段，并附加：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| originalUrl | string | 元数据中的 HTTP(S) 原作品链接，缺失或协议不支持时为空 |
| assets | Asset[] | 按页码排列的展示媒体列表 |

详情通常不含仅用于搜索结果的 `approximate`。作品不存在返回 404。目录离线时详情仍可能由保留的索引返回，但媒体读取会失败。

### 5.4 PUT /api/works/:id/favorite

请求体中的 `favorite` 必填：

```json
{ "favorite": true }
```

200 返回同结构；传 false 取消收藏。作品不存在返回 404。收藏保存在服务端 SQLite，所有客户端共享。

## 6. 媒体读取与转码

### 6.1 GET /api/assets/:id/file

返回原媒体二进制，Content-Type 根据扩展名设置，未知格式为 `application/octet-stream`。媒体不存在、目录离线或文件不在所属来源目录内时返回 404。

### 6.2 GET /api/assets/:id/thumbnail

按需生成并缓存 WebP 缩略图，宽高限制在 640 内。图片使用 Sharp，视频及 WebM 使用 FFmpeg。

如果媒体可访问但缩略图生成失败（例如缺少 FFmpeg），返回 200、`image/svg+xml` 占位图，缓存 60 秒；不应假设所有成功响应都是 WebP。媒体本身不可访问返回 404。

### 6.3 通用 Range 与缓存行为

原文件、成功生成的缩略图、兼容视频和漫画 PNG 底图使用相同的媒体输出逻辑：

| 请求头 / 响应头 | 行为 |
| --- | --- |
| `Accept-Ranges: bytes` | 响应声明支持字节范围 |
| `ETag` | 由文件大小和修改时间生成，客户端应原样保存 |
| `Cache-Control` | `private, max-age=3600` |
| `If-None-Match` | 与 ETag 完全相等且没有 Range 时返回 304 |
| `Range` | 支持 `bytes=0-1023`、`bytes=1024-`、`bytes=-1024` |
| `If-Range` | 缺省或与 ETag 完全相等时处理 Range；否则返回完整文件 |
| `Content-Range` | 部分响应形如 `bytes 0-1023/4096` |
| `Content-Length` | 当前响应的字节数 |

只支持单段 Range，多段或非法范围返回 416，并带 `Content-Range: bytes */总大小`；范围终点超过文件末尾会截断。`If-Range` 不支持 HTTP 日期比较。上述规则不适用于 SVG 占位图。

### 6.4 POST /api/assets/:id/convert

无需请求体。为视频生成 H.264 / AAC MP4 缓存。静态图片和 GIF 返回 400，媒体不可访问返回 404。

通过前置校验后 HTTP 状态为 202，正文为 ConversionJob：

```json
{ "state": "queued" }
```

| state | 含义 |
| --- | --- |
| queued | 等待转码 |
| processing | 正在转码 |
| ready | 已生成兼容版本，可立即读取 |
| failed | 未生成或失败，`message` 给出原因 |

重复调用会复用现有任务或缓存。缺少 FFmpeg、队列已满时也返回 **202 + failed**，必须检查正文。等待及处理中任务最多共 5 个，转码串行执行；失败后可重新 POST。

### 6.5 GET /api/assets/:id/convert

200 返回 ConversionJob；未知媒体 ID 返回 404。尚未请求生成时返回：

```json
{ "state": "failed", "message": "尚未生成兼容版本" }
```

该查询只检查索引、任务和缓存，不执行转码，也不检查来源在线状态。任务状态在内存中，已生成文件可在重启后继续识别为 ready。

### 6.6 GET /api/assets/:id/compatible

ready 时返回 `video/mp4`，支持 Range。未就绪、文件或来源不可访问时返回 404。

推荐流程：POST convert → 轮询 GET convert → ready 后读取 compatible；failed 时显示 message。

## 7. AI 配置与作品信息翻译

### 7.1 AiSettings

| 字段 | 类型 | 默认值 / 说明 |
| --- | --- | --- |
| baseUrl | string | `https://api.deepseek.com` |
| apiKey | string | 空；由用户填写上游 Token |
| model | string | `deepseek-flash` |
| targetLanguage | string | `简体中文` |
| appendPrompt | string | `shared/prompts.ts` 中的 DEFAULT_APPEND_PROMPT；空串表示不追加 |
| params | object | `{"thinking":{"type":"disabled"}}` |
| timeoutMs | number | 120000，归一化到 5000–600000 并取整 |
| mangaPipelineMode | string | `sequential`；另支持 `merged`、`parallel` |
| mangaConcurrency | number | 3，归一化到 1–10 并取整，仅 parallel 模式使用 |

无配置文件或相应字段缺失时使用默认值。显式 `params: {}` 清空自定义参数；非法 params（如数组、null）归一化为空对象。显式空 model 会保留，实际调用需补齐。

### 7.2 GET /api/ai/settings

无需参数，200 返回完整 AiSettings，包含 **未掩码的 apiKey**。客户端应避免把响应写入日志或公开展示。

### 7.3 PUT /api/ai/settings

请求体为 AiSettings，200 返回归一化后保存的完整配置。

**这是整体替换，不是 PATCH。** 缺失字段按默认值或空值补齐，不继承原配置；例如遗漏 `apiKey` 会清空 Token。建议先 GET，再修改需要变更的字段后 PUT 完整对象。

`baseUrl` 必须以 HTTP(S) 开头，否则返回 400。保存不会测试连接，也不要求立即填写 Token；配置写入服务端 `data/ai.json`（随 MEDIA_DATA_DIR 改变）。

```json
{
  "baseUrl": "https://api.deepseek.com",
  "apiKey": "YOUR_API_TOKEN",
  "model": "deepseek-flash",
  "targetLanguage": "简体中文",
  "appendPrompt": "",
  "params": { "thinking": { "type": "disabled" } },
  "timeoutMs": 120000,
  "mangaPipelineMode": "sequential",
  "mangaConcurrency": 3
}
```

上例使用空追加提示词；需要保留内置默认追加内容时使用 GET 返回的值。

### 7.4 POST /api/ai/test

请求体可省略或为 AiSettings 的部分字段。未提供字段继承当前已保存设置，提供的 `params` 整体替换原参数；此次覆盖不保存。

服务端向上游聊天接口发送 `hello`，成功 200：

```json
{ "reply": "Hello!", "model": "deepseek-flash", "elapsed": 320 }
```

`reply` 最多保留 200 字符。缺少 Token 或模型返回 400；连接、超时和响应格式错误见通用错误表。测试是实际上游调用。

### 7.5 POST /api/ai/models

请求体可省略或传临时配置，合并规则同连接测试。要求 Token，不要求已选择模型。

200 返回去重、排序后的模型名称：

```json
{ "items": ["deepseek-flash"] }
```

模型清单以供应商实时返回为准；无可用模型返回 502。

上游 URL 补全规则：完整 `/chat/completions` 地址替换末段得到 `/models`；以 `/v1` 结尾则追加 `/chat/completions` 或 `/models`；其他地址追加 `/v1/chat/completions` 或 `/v1/models`。

### 7.6 POST /api/ai/translate

同步翻译文本，请求体：

```json
{
  "fields": {
    "title": "夏の午後",
    "author": "作者名",
    "description": "海辺の風景",
    "tags": ["夏", "海"]
  },
  "targetLanguage": "简体中文",
  "force": false
}
```

| 字段 | 说明 |
| --- | --- |
| fields | 支持 title、author、description 字符串和 tags 字符串数组；至少一个有效非空字段 |
| targetLanguage | 可选，缺失或空值使用已保存目标语言 |
| force | 仅布尔 true 绕过缓存并覆盖原译文 |

不用提交作品 ID，服务端翻译调用者提供的文本，不修改作品原始元数据。

200 示例：

```json
{
  "fields": { "title": "夏日午后", "author": "作者名", "description": "海边风景", "tags": ["夏天", "海"] },
  "cached": false,
  "model": "deepseek-flash",
  "createdAt": 1791000000000,
  "targetLanguage": "简体中文"
}
```

- 空字段及非法标签项会过滤；没有有效字段返回 400。
- 模型缺失的单个文本字段回退原文；tags 整体缺失时回退原标签。如果模型完全没有提供匹配字段，返回 502。
- API 不保证返回 tags 数量与原数组一致；需要逐项展示的客户端自行处理缺项。
- 缓存依据清洗后的原文字段与目标语言，换模型、提示词或参数不会自动失效；用 force 重译。
- 即便命中缓存，此接口仍先检查 Token 和模型是否已配置。
- 翻译请求固定 model、messages、response_format、stream，自定义 params 不能覆盖这些字段。

### 7.7 DELETE /api/ai/cache

无需请求体，200：

```json
{ "removed": 12 }
```

仅清空作品信息翻译的 `translations` 表。不会清空漫画翻译缓存、模型文件或 AI 配置。

## 8. 漫画图片翻译

### 8.1 GET /api/ai/manga/status

检查模型文件是否存在，不触发下载或推理，也不代表 GPU 已成功初始化。200 示例：

```json
{
  "ready": false,
  "device": "DirectML（不可用时回退 CPU）",
  "models": [
    { "name": "comic-text-detector", "ready": true, "files": ["comic-text-detector.onnx"], "missing": [] },
    {
      "name": "manga-ocr",
      "ready": false,
      "files": ["encoder_model_fp16.onnx", "decoder_model_quantized.onnx", "vocab.txt"],
      "missing": ["encoder_model_fp16.onnx"]
    }
  ],
  "message": "首次翻译会自动下载模型到服务器模型目录；网络不通时设置 HF_ENDPOINT 指向镜像站"
}
```

`message` 为可选展示文本，实际值可能包含服务端路径。`device` 按运行平台给出预期执行方式。首次需要 OCR 时会自动下载缺失的 HuggingFace 文件；所有平台使用固定 fp16 encoder，旧量化 encoder 不算模型就绪。

### 8.2 POST /api/ai/manga/translate

单页请求：

```json
{ "assetId": "asset-id", "force": false }
```

批量请求：

```json
{ "assetIds": ["asset-id-1", "asset-id-2"], "force": false }
```

- `assetIds` 是数组时优先使用它，即使为空，也不会回退 `assetId`。非空字符串 ID 自动去重。
- 无有效 ID 返回 400。逐个检查媒体，只允许 `kind=image` 且扩展名不是 gif；类型不符返回 400，不存在或目录离线返回 404，前置校验失败不创建任务。
- 目标语言、流水线模式和并发数来自已保存配置，此接口没有对应覆盖参数。
- `force: true` 请求重新识别和翻译。相同媒体 ID 集合已有 queued/processing 任务时复用该任务，force 不会另外创建并行副本。
- 正常返回 **200 和 MangaJob**，不是 202。单页缓存命中可能直接 ready，其他情况异步处理；请求成功不保证任务最终成功。

```json
{
  "id": "job-id",
  "state": "queued",
  "stage": "等待翻译 2 张图片",
  "progress": 0,
  "total": 2,
  "completed": 0
}
```

返回时任务可能已进入 processing，客户端不应要求首个状态必须是 queued。

### 8.3 GET /api/ai/manga/jobs/:id

200 返回 MangaJob：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 任务 ID |
| state | string | queued、processing、ready、failed |
| stage | string | 当前阶段展示文本，不作为稳定枚举 |
| progress | number | 阶段进度数值；不能用它代替 state 判断任务终止 |
| total | number | 去重后的图片总数 |
| completed | number | 已处理页数，包含按流程记录的失败页 |
| currentAssetId | string，可选 | 当前处理媒体 |
| message | string，可选 | 失败或部分失败说明 |
| result | MangaPageResult，可选 | 单个结果便捷字段；多页客户端以 results 为准 |
| results | 数组，可选 | 已成功完成的 `{ assetId, result }` |
| failed | 数组，可选 | 失败的 `{ assetId, message }` |

results 和 failed 为空时省略，客户端可用空数组作为回退值。queued、processing 是进行中状态；ready、failed 是终止状态。**ready 允许部分页面失败**，应同时读取 `failed`。所有页面失败或任务整体异常时为 failed。

任务仅存于当前服务进程内，重启后查询原任务返回 404；译文缓存保存在磁盘和数据库中，可重新提交媒体 ID 获取缓存结果。没有任务取消、任务列表或进度推送接口；客户端定时轮询即可。

### 8.4 MangaPageResult 与气泡坐标

```json
{
  "key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "width": 1200,
  "height": 1800,
  "baseUrl": "/api/ai/manga/cache/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/base.png",
  "regions": [
    {
      "id": 0,
      "x": 100, "y": 200, "width": 180, "height": 260,
      "source": "こんにちは", "translation": "你好",
      "detection": 0.95, "confidence": 0.92,
      "background": "#ffffff", "textColor": "#111111"
    }
  ],
  "cached": false,
  "model": "deepseek-flash",
  "targetLanguage": "简体中文",
  "createdAt": 1791000000000
}
```

- `width`、`height` 和 region 的 `x`、`y`、`width`、`height` 均按原图像素表示；x/y 是左上角坐标。
- `source` 是 OCR 原文，`translation` 是译文，`detection` 是检测置信度，`confidence` 是 OCR 置信度。
- `background`、`textColor` 为擦字底色和建议文字颜色。客户端负责依据气泡尺寸排版绘制译文，可参考 `src/manga-layout.ts`。
- **baseUrl 返回的是擦字底图，不是已绘制译文的成品图。** 客户端需叠加 regions 中的文字。
- 未识别到可翻译文本时，regions 为空，width/height 可能为 0，model 可能为空，baseUrl 回退为原媒体 URL；此时直接显示原图。
- 缓存依据文件内容哈希、目标语言、流水线版本。更换模型、参数或流水线模式不自动使缓存失效；force 可强制重译。
- 本地执行检测与 OCR，识别出的文本发送到 AI 上游，图片本身不发送到上游翻译接口。

### 8.5 GET /api/ai/manga/cache/:key/base.png

返回 `image/png`，支持第 6.3 节的 Range 与缓存协议。key 必须是 64 位小写十六进制，且数据库中有对应底图、文件实际存在；否则返回 404。

应优先使用 MangaPageResult.baseUrl，因为没有文本的结果可能指向原文件。

### 8.6 批量模式

| 模式 | 处理方式 | 失败影响 |
| --- | --- | --- |
| sequential | 每页依次完成检测、OCR、翻译、擦字 | 单页失败继续其余页面 |
| merged | 先逐页识别，将文本按最多 200 段一批合并请求 | 合并调用失败会影响本次等待合并翻译的页面 |
| parallel | 先逐页识别，再按页并发调用翻译 | 单页翻译失败单独记录，并发数由 mangaConcurrency 决定 |

已有缓存和无可翻译文本的页面可以直接产出结果。通过 results 的逐步增加展示已完成页面，终止后汇总 failed。

## 9. 调用示例

### 9.1 PowerShell：浏览与收藏

```powershell
$base = 'http://localhost:3210'
$status = Invoke-RestMethod "$base/api/status"
$works = Invoke-RestMethod "$base/api/works?page=1&sort=newest"
if ($works.items.Count -gt 0) {
    $workId = [uri]::EscapeDataString($works.items[0].id)
    $detail = Invoke-RestMethod "$base/api/works/$workId"
    Invoke-RestMethod "$base/api/works/$workId/favorite" `
        -Method Put -ContentType 'application/json' -Body '{"favorite":true}'
}
```

### 9.2 浏览器：漫画翻译与轮询

以下代码在与服务同源的页面中调用；assetIds 来自作品详情的 assets，先过滤静态图片。

```javascript
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

async function translatePages(assetIds) {
  let job = await api('/api/ai/manga/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetIds, force: false })
  });
  while (job.state === 'queued' || job.state === 'processing') {
    console.log(job.stage, job.completed, job.total);
    await new Promise(resolve => setTimeout(resolve, 1500));
    job = await api(`/api/ai/manga/jobs/${encodeURIComponent(job.id)}`);
  }
  if (job.state === 'failed') throw new Error(job.message || '漫画翻译失败');
  for (const failure of job.failed || []) console.warn(failure.assetId, failure.message);
  return job.results || [];
}
```

此轮询间隔仅为调用示例，不是服务端强制要求。展示结果时加载每页 result.baseUrl 并叠加译文。

### 9.3 curl：媒体范围读取

在 Windows PowerShell 中使用 `curl.exe`，避免旧版 PowerShell 的 curl 别名：

```powershell
curl.exe -I "http://localhost:3210/api/assets/ASSET_ID/file"
curl.exe -H "Range: bytes=0-1023" "http://localhost:3210/api/assets/ASSET_ID/file" -o media-part.bin
```

## 10. 实现索引

- `server/app.ts`：HTTP 路由、输入校验、访问控制和状态码。
- `shared/types.ts`：公共请求、响应数据类型。
- `server/search.ts`、`shared/search-query.ts`：搜索及标签规则。
- `server/directories.ts`：目录浏览和文件系统错误映射。
- `server/media.ts`：Range、ETag、缩略图和转码队列。
- `server/ai.ts`：AI 配置、上游调用、文本翻译和缓存。
- `server/ai/manga/service.ts`、`models.ts`：漫画任务、模型检查及自动下载。
