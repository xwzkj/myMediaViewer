# 中文 CLIP 以文搜图（MVP）

这是与漫画 OCR/翻译相互独立的功能，复用现有的 `onnxruntime-node`、`sharp`、Node SQLite 与 Fastify，不新增运行时依赖。语义模型权重**不随仓库分发**：与漫画模型一样，首次使用时自动下载并缓存在磁盘上。

## 模型：全自动下载

**不需要任何环境变量。** 第一次真正需要语义能力时（状态轮询或第一个索引任务），程序会把 Chinese-CLIP 下载到当前进程的模型目录：

```text
<数据目录>/models/chinese-clip-vit-b16/
  model.onnx       # Xenova/chinese-clip-vit-base-patch16 的 onnx/model_quantized.onnx
  tokenizer.json   # Xenova/chinese-clip-vit-base-patch16 的 tokenizer.json（中文 BERT WordPiece 词表）
```

量化权重约 182 MB。下载期间 `GET /api/semantic/status` 会在 `message` 里给出进度并带上 `downloading: true`，界面据此显示进度条而不是报错。下载失败会保留可操作的原因（提示可用 `HF_ENDPOINT` 换镜像站），30 秒冷却后自动重试；任何情况下都不会伪造「已就绪」，也不会返回占位向量。

**主服务与计算端各自解析自己的目录。** 目录固定为 `<MEDIA_DATA_DIR>/models/chinese-clip-vit-b16`，因此：

- 两端在不同机器上：各自在首次使用时下载自己的一份；
- 同一台机器、同一份代码：共用同一份下载结果（临时文件带进程号，首次并发下载不会互相覆盖）；
- 需要把计算端放到独立磁盘：只在该进程设置 `SEMANTIC_CLIP_MODEL_DIR`。这是可选覆盖，不是前提条件。

模型懒加载，加载后在进程内复用。主服务在首次创建语义 provider 时快照当时的本地计算线程数，之后修改线程需要重启服务；计算端接受 `SEMANTIC_CLIP_THREADS`（默认 `min(4, 核心数)`，限制 1–16）。原生会话串行推理，inter-op 线程固定为 1。替换模型文件需要重启进程。

张量契约（单图双塔，一次前向同时给出两路输入）：

- 输入：`input_ids`（int64 `[1,N]`）、`attention_mask`（int64 `[1,N]`）、`pixel_values`（float32 `[1,3,224,224]`）。只编码文本时喂一张全零占位图，只编码图片时喂一对 `[CLS]`/`[SEP]`。
- 输出：`text_embeds` 与 `image_embeds`，各 512 维有限值，写入前做 L2 归一化。
- 分词：中文 BERT WordPiece，词表 21128，`[CLS]`=101、`[SEP]`=102、`[UNK]`=100；小写、去重音、CJK 逐字成词、长词按 `##` 续接；查询截断到 77 个 token（含首尾特殊符）。
- 图片预处理：EXIF 方向、RGB、直接缩放到 224×224（不做中心裁剪）、CLIP 逐通道 mean/std。Sharp 的插值与 PIL 可能有细微差异，改动预处理必须重建索引。

模型标识是 `chinese-clip-vit-b16:<SHA-256>`，覆盖 ONNX 权重、词表与预处理版本。本地与远程必须使用逐字节一致的产物才能共享索引。不支持的模型或输出会给出明确错误，绝不返回占位向量。支持单文件 ONNX 导出；外置数据 sidecar 不在本 MVP 契约内。

**语言支持：** 中文与英文画面描述都可用，中文是主场景。实测同一张漫画页：中文相关 0.4550 / 中文无关 0.2386，英文相关 0.4389 / 英文无关 0.2703（余弦相似度，非概率）。这是图像相似度，不是 OCR，也不是元数据关键词匹配；界面不会偷偷调用在线翻译。

## 索引与搜索

自动索引由后台调度器负责，遵循来源级的显式启用策略；语义搜索本身不枚举、不索引文件。只有已展示的本地静态图片资源会被索引，视频、动图与仅云端记录不会用封面缩略图悄悄顶替。

- `GET /api/semantic/status`：就绪状态、实际 provider、模型标识、维度、当前模型下的图片/作品索引数，以及可直接展示的提示信息。
- `POST /api/semantic/assets/:id/index`：显式手建索引。读取已授权的本地资源，推理前后各校验一次大小与修改时间，拒绝竞态。返回 `{indexed:true}` 或 `{indexed:false,reason:'cached'|'unsupported'}`。该操作不会因此开启自动索引。
- `GET /api/works?semantic=true&q=a%20cat&sort=relevance`：沿用普通作品列表的响应结构，每条结果附带 `semanticScore` 与 `semanticAssetId`。支持已有的来源/媒体类型/收藏筛选、确定性分页与常规排序；默认按相似度降序。
- 搜索菜单：**CLIP 画面语义** 开关只在本地搜索结果页显示，会切换语义模式，写进搜索 URL，关闭关键词联想与模糊匹配，显示就绪状态与索引覆盖量，失败时提供显式回退到关键词搜索的入口。开关状态随本地搜索的其他筛选一起保存在服务端，旧链接缺少 `semantic` 参数时使用上次记忆。云搜索与普通关键词搜索不受影响。

向量是以小端 Float32 存储的 512 维归一化 BLOB（每条 2,048 字节），保存在 `library.sqlite` 的 `semantic_embeddings` 表，主键为资源 id + 模型 id。指纹包含资源路径、大小与修改时间。查询时与当前 assets/works 行做 JOIN，自动忽略已变更、已删除、不支持或损坏的记录；内容未变的重新扫描会保留向量。刻意保持大小与修改时间都不变的替换无法识别（与现有媒体缓存的限制相同）。

检索使用精确余弦相似度；每组作品取**图片最高分**，而不是会让多图作品占优的求和。同分先按作品 id、再按资源 id 决定最佳图片。分数范围 `[-1,1]`，**不是概率**。MVP 会对全部已索引候选排序（没有统一置信度阈值）；向量扫描每 256 行让出一次事件循环并使用有界的 SQLite 批次，复杂度与索引图片数成线性关系，而不是 ANN 索引。

### 外部编码器的接入边界

`server/semantic/provider.ts` 中的 `SemanticProvider` 支持在测试或外部嵌入应用中注入真实实现。以下同源/局域网接口供可信工具使用，不接受任何文件系统路径：

```text
PUT /api/semantic/assets/:id/vector
{ model: string, vector: number[512], size: number, modified: number }

POST /api/semantic/search
{ model: string, vector: number[512], source?: string, favorites?: boolean,
  page?: integer, minScore?: number in [-1,1] }

DELETE /api/semantic/assets/:id/vector
```

写入时必须提供资源当前的大小与修改时间；外部生产者自行负责使用匹配的编码器。空向量、全零、非有限值或维度不符都会校验失败，不同模型命名空间永不混用。向量检索接口可以在没有文本模型时使用，但它不是自然语言搜索的替代品。

## 远程计算

主服务侧沿用 `getLocalComputeConfig()` 的模式、地址、Bearer Key、超时与回退策略。语义路由作为独立模块注册进已有的鉴权计算应用（不导入主服务配置、数据库或漫画处理逻辑）：

```text
GET  /v1/semantic/status
POST /v1/semantic/text   application/json {query:string}
POST /v1/semantic/image  application/octet-stream <图片字节>
```

所有接口都要求已有的 Bearer Key；编码请求还必须带上状态响应里的 `x-semantic-model`。响应为 `{model,dimensions:512,vector:number[512]}`。上传沿用 128 MB 上限与 1 亿像素解码上限；同一时刻只允许一个语义操作（繁忙时返回 429）。

每次远程操作都会先做鉴权的 `GET /v1/status` 健康检查。健康检查失败一律视为离线，不再发送任何语义请求；只有现有策略为 `local` 时才回退，否则返回不可用。基础健康检查通过后，语义路由缺失/状态异常或传输失败也允许按配置回退本地。进行中的失败只有在本地模型哈希完全一致时才允许回退；语义路由鉴权失败、模型不匹配、向量非法与输入被拒绝都不会静默回退。任何响应都不暴露远程凭据。没有语义路由的旧计算端会得到确定性的「不可用」结果。

## 验证与边界

```text
node --import tsx --test tests/semantic-search.test.ts tests/semantic-remote.test.ts tests/semantic-tokenizer.test.ts tests/semantic-models.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
```

测试使用显式标注为测试专用的注入式编码器，覆盖持久化、维度校验、最高分聚合、过期/损坏隔离、筛选、API 错误、本地/远程回退与鉴权。byte-BPE 实现另外用官方分词词表核对过（`a photo of a cat` → 49406,320,1125,539,320,2368,49407）。测试不会下载完整 ONNX 权重；真实端到端质量与延迟必须在部署时选定的产物上自行验证一次，再依赖检索效果。

模型来源：

- https://huggingface.co/Xenova/clip-vit-base-patch32
- https://huggingface.co/openai/clip-vit-base-patch32
