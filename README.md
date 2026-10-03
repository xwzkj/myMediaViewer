# 拾光 · Media Garden

本地媒体查看器，使用 Vue 3、TypeScript、Vite、Fastify 和 SQLite。界面按 Material Design 3 的色彩角色、曲面、圆角、导航和状态设计，支持浅色 / 深色模式及手机布局。可选 AI 翻译支持作品信息与漫画图片，兼容 OpenAI 接口。

项目使用 Codex（AI 编程助手）编写。

## 启动

需要 Node.js 24 或更新版本、pnpm 11。FFmpeg 为可选依赖，用于视频封面和兼容版本；AI 翻译需要自行准备 OpenAI 兼容接口的地址与 Token，漫画图片翻译首次使用时会自动下载本地 ONNX 模型（见「AI 翻译」）。

```powershell
pnpm install
pnpm start
```

`pnpm start` 会先构建再启动。只想启动已经构建好的产物、不重新构建时用 `pnpm serve`。

打开 `http://localhost:3210`，进入「媒体库设置」点击「添加目录」，在文件夹选择器中打开磁盘、逐级浏览文件夹，再点击「选择此文件夹」。支持面包屑返回、上一级、当前层级名称筛选和已添加目录快捷入口，无需手动输入路径。选择器浏览的是**运行服务的电脑**，手机也可以直接操作，不会上传文件。目录名称默认使用文件夹名称，可自行修改。

首次启动不预设目录。可以添加任意数量的目录，每个目录选择 Pixiv 或 Telegram 的命名规则；编辑已有目录时，点击「更改」可重新选择路径。

开发模式：`pnpm dev`，前端在 `http://localhost:5173`，Vite 将 `/api` 代理给 3210 端口。

## 使用

- **作品分组**：Pixiv 按作品 ID 合并，Telegram 按编号和年月合并；页码按数字排序，重复导出的同页保留一个展示项。Pixiv 支持 GIF / WebM 动图，同作品同页优先展示 WebM。WebM 静音自动循环播放，媒体文件保留原位。
- **浏览**：前端是 Vue Router 单页应用，媒体库、收藏、媒体来源、搜索、设置和作品详情分别使用独立 URL；列表滚动到接近底部时自动加载下一批，后台扫描完成后只刷新最新的一批并保留已加载的内容。
- **来源记忆**：打开 `/` 时恢复上次查看的媒体来源（若上次停在收藏也会恢复收藏页）；点击侧栏「媒体库」会进入 `/library`，明确查看全部来源。列表页使用 `KeepAlive` 保留滚动位置和已加载内容。
- **返回**：从作品页返回列表时会自动滚动并居中到刚才那组作品的卡片；作品页内切换上下组只替换当前记录，连续翻页后浏览器返回仍直接回列表；点击标签或作者会进入搜索结果，搜索页不会滚动到来源作品；浏览器返回键会先回到原作品页。
- **界面**：顶部搜索栏提供搜索和亮暗切换；右侧筛选菜单包含媒体来源、媒体类型、模糊匹配、排序方式和时间依据，支持手机布局。视频与动图统一归入「视频」筛选。
- **元数据**：Pixiv 优先读取下载器生成的 `-meta.json`（字段最全，含翻译标签、原图链接和 JSON 里的简介），缺失字段再用 `-meta.txt` 补齐。Telegram 侧以 txt 为主，同样支持 json；没有元文件时显示作品编号。文本编码支持 UTF-8、带 BOM 的 UTF-16 和 GB18030 回退，json 里的 HTML 简介会在显示前转成纯文本。
- **排序**：默认按收藏顺序排列，也就是文件名开头的收藏编号——Pixiv 是收藏 ID（`bmk_id`，如 `38885063179-133752873_p0.webm`），Telegram 是消息号——从大到小，与你收藏作品的先后一致；同一作品出现两个收藏编号时取较大的那个。这串编号只在同一个媒体目录内部可比：两种含义和量级都不同，所以混合显示多个目录时开关会停用并自动按发布时间排列，选中某个目录后即可按收藏顺序浏览。点开关也能随时改用发布时间，标题排序不受影响。
- **搜索**：关键词用空格分隔，所有关键词均需命中，可分布在标题、作者、标签、描述或编号中。支持部分文字、简繁体、全半角、大小写、全拼及首字母。开启「模糊匹配」后加入错漏字候选。搜索使用 SQLite 持久化数据与内存文本索引。
- **播放**：原图、GIF、浏览器支持的视频直接播放。作品页支持数字页码切换、方向键、自动翻页、全屏和原文件链接；手机上左右滑动图片 / 视频区域切换分 P，滑到第一张 / 最后一张后继续滑动就切到上一组 / 下一组作品（往回切会停在上一组的最后一页，只有一张媒体时同样如此）；滑动信息区等其他位置直接切换作品；桌面端按住图片拖动、方向键和左右箭头按钮行为一致，都可以一路翻到底。对不支持的视频，点击「生成兼容版本」，通过 FFmpeg 生成 H.264 / AAC MP4 缓存。
- **收藏**：整组收藏存入 SQLite，各设备共享；重新扫描和编辑同一个媒体目录的路径会保留收藏。移除目录会清理该目录索引和收藏记录，不删除原文件。
- **更新**：启动时和每 5 分钟检查一次目录，也可以手动刷新。元文件的大小和修改时间都没变就复用解析缓存，解析逻辑升级时会自动重新解析；目录离线或扫描失败时保留已有索引。
- **AI 翻译**：可选功能，作品页可翻译标题、作者、标签、简介，静态图片还能识别日文并回填译文；先在设置页「AI 翻译」配置兼容接口，漫画图片还需要本地 ONNX 模型（详见下文）。

## AI 翻译

AI 功能全部可选，未配置时不影响浏览、搜索和播放。设置页的「AI 翻译」面板连接 OpenAI 兼容接口，作品信息翻译与漫画图片翻译共用同一套配置，由服务端携带 Token 发起请求。作品信息和漫画文本会发送到该接口；图片不会上传，漫画在本地完成检测与识别，只有识别出的文字交给模型翻译。

### 接口配置

默认使用 DeepSeek：接口地址为 `https://api.deepseek.com`，模型为 `deepseek-flash`，自定义参数为 `{"thinking":{"type":"disabled"}}`。使用前填写自己的 API Token；已有配置会继续保留。

- **接口地址**：填到 `/v1` 或完整的 `/chat/completions` 地址都可以，程序会自动补全聊天与模型列表路径。
- **API Token / 模型**：Token 明文保存在服务端 `data/ai.json`；可以点「获取模型列表」从接口拉取模型，也可以手动填写模型名。接口地址、Token、模型和参数都支持在保存前先「测试连接」。
- **目标语言**：默认「简体中文」，作品信息与漫画译文都使用这个语言。
- **自定义参数**：填写 JSON 对象后原样合并进请求体，可用来关闭思考或设置思考等级 / 预算，例如 `reasoning_effort`、`thinking`、`thinking_budget`、`temperature`；`model`、`messages` 等由程序控制的字段不允许覆盖。
- **超时时间**：5 - 600 秒，默认 120 秒。
- **漫画翻译流水线**：逐页处理 / 先批量识别再合并翻译 / 先批量识别再并发翻译；并发模式可另设 1 - 10 的大模型并发数（见下文「流水线模式」）。
- **提示词**：作品信息与漫画气泡各有一套内置系统提示词，只读不可编辑；可以追加一段自己的要求，两处都会生效，也可以一键恢复默认追加内容。

### 作品信息翻译

在作品页点「AI 翻译」，会把标题、作者、标签和简介一起发给模型，并要求按相同 JSON 结构返回译文；标签按位置一一对应，模型漏给时回退显示原文。译文支持「原文 + 译文」「仅译文」「仅原文」三种显示方式，再点「重新翻译」会绕过缓存强制请求。

译文按「原文 + 目标语言」缓存在 SQLite 的 `translations` 表：换模型、改提示词或改自定义参数都不会让已有译文失效。超时、接口报错、模型返回不是 JSON 或缺少字段等原因会显示在作品页，终端也会打印原始返回。

### 漫画图片翻译

漫画翻译只处理静态图片（GIF 除外），按「本地识别 → AI 翻译 → 擦字回填」执行：

1. **检测**：`comic-text-detector`（CTD）找出文字框和文字像素 mask，内部 letterbox 到 1024² 推理后再映射回原图坐标。
2. **识别**：`manga-ocr` 按框裁剪并批量识别日文；过滤低置信度、过小、非日文的框，按日漫阅读顺序（从上到下、每行从右到左）排序，每页最多保留 80 处文本。
3. **翻译**：把这一页的文本作为 JSON 数组一次性交给 AI，要求返回等长、同顺序的译文数组；少返或漏返的条目回退原文。
4. **回填**：用 CTD 的 mask 膨胀 1px 擦除原文，按文字框边缘估算气泡底色并回填；前端 Canvas 根据气泡尺寸自动换行、缩放后画上译文。译图与原文可随时切换，详情区还会列出逐条对照。

模型文件由程序从 HuggingFace 自动下载到 `data/models`：检测模型来自 [mayocream/comic-text-detector-onnx](https://huggingface.co/mayocream/comic-text-detector-onnx)，OCR 模型来自 [onnx-community/manga-ocr-base-ONNX](https://huggingface.co/onnx-community/manga-ocr-base-ONNX)，词表来自 [kha-white/manga-ocr-base](https://huggingface.co/kha-white/manga-ocr-base)。

```text
data/models/
├── manga-ocr/
│   ├── encoder_model_fp16.onnx
│   ├── decoder_model_quantized.onnx
│   └── vocab.txt
└── comic-text-detector/
    └── comic-text-detector.onnx
```

首次需要识别图片时下载缺失的模型文件并加载，进程内复用模型会话。重启服务后会重新加载已有文件。无法访问 huggingface.co 时，可设置 `HF_ENDPOINT` 指向可用镜像站。

所有平台使用同一套模型文件：fp16 encoder 与量化 decoder。Windows 下 CTD 和 encoder 使用 DirectML / CPU 执行提供程序，其他平台使用 CPU；decoder 使用 CPU。

任务按「翻译本页」或「翻译整部」入队，前端轮询显示当前阶段；整部翻译逐张返回结果，单页失败不会中断其余页面，失败原因按页列出。译图按「文件内容哈希 + 目标语言 + 流水线版本」缓存：修改图片或切换目标语言会重新生成，其余情况直接复用 `data/cache/manga` 的译图底图和 SQLite 里的坐标、译文。

### 流水线模式

整部翻译有三套流程，在设置页「AI 翻译 → 漫画翻译流水线」里选择，默认逐页处理。实际耗时取决于本地识别性能、文本量和接口响应速度。

- **逐页处理**：一页走完「检测 → OCR → 翻译 → 回填」再处理下一页。内存占用最低，任何一步失败只影响当前页。适合单页翻译或内存紧张的环境。
- **先批量识别，再合并翻译**：先把整部图片的检测与 OCR 全部跑完，再把所有页的文本拍平成一个数组，合并成尽量少的几次请求（每批最多 200 段）。可减少请求次数；合并调用失败会影响本次任务中等待合并翻译的页面。
- **先批量识别，再并发翻译**：识别阶段与上一种相同，之后每页各发一个请求，按设置的并发数同时进行。可缩短等待多个请求的时间，单页失败只影响该页；遇到接口限流时可调低并发数。

并发翻译模式的并发数范围为 1 - 10，默认 3；设为 1 即退化为依次发送。三种模式共用同一份本地识别代码与缓存键，切换模式不会让已有译图缓存失效。

## 日志

默认终端日志包括：

- **接口**：方法、路径、状态码和耗时。前端每 2 秒的状态轮询，以及缩略图、原图、视频、漫画译图底图等二进制请求不记录。
- **关键操作**：启动信息、媒体目录的新增 / 修改 / 移除、媒体库整理结果、视频兼容版本转码、AI 设置更新与翻译缓存清理。
- **队列进度**：漫画翻译任务的入队、逐张完成（缓存命中或识别出的气泡数）、整体耗时；每 5 分钟的自动对账没有变化时保持安静。
- **调用与报错**：对 AI 接口的每次调用记录用途、模型、地址、状态和耗时；请求失败时输出状态码和具体原因，同一个失败只记一次。
- **原始返回**：模型返回无法解析为 JSON、缺少预期字段、没有返回译文数组、译文与原文相同，或接口返回非 2xx 与非法 JSON 时，会把原始内容按行打印出来（默认最多 40 行 / 4000 字符，超出会标注总长度），方便直接对照模型到底回了什么。

需要查看 Fastify 的逐请求日志时，用 `LOG_LEVEL=debug` 启动：

```powershell
$env:LOG_LEVEL = 'debug'
pnpm start
```

## 手机 / 局域网

生产服务默认监听 `0.0.0.0:3210`。在「媒体库设置」中查看局域网地址，用同一 Wi-Fi 下的设备打开。保持电脑与服务运行，并允许 Windows 防火墙的专用网络入站连接。开发模式手机应访问 5173；设置页显示的是生产服务端口。

服务默认**只接受局域网与保留地址**的请求：`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`100.64/10`（运营商级 NAT，含 Tailscale 等）和 `198.18/15`（TUN 虚拟网卡常用网段），以及 IPv6 的回环、`fc00::/7` 和 `fe80::/10`；其余公网地址一律返回 403。带有 `X-Forwarded-For` 等转发头的请求同样被拒绝，因为本机反向代理或隧道也会显示成 `127.0.0.1`，无法和服务直连区分。确实需要公网访问时，设置环境变量后重启服务：

```powershell
$env:ALLOW_PUBLIC_ACCESS = '1'
pnpm start
```

当前是**可信家庭局域网共享模式**：没有账号系统，同一局域网内可访问该端口的设备能够浏览媒体、修改收藏和配置目录。放开公网开关前请谨慎，并保证端口只对本机或可信网络开放，不要直接转发到互联网。

## 配置和数据

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3210` | HTTP 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址，仅本机可设为 `127.0.0.1` |
| `MEDIA_DATA_DIR` | `./data` | 数据库、目录配置和缓存存放位置 |
| `HF_ENDPOINT` | `https://huggingface.co` | 本地识别模型的下载站点，可设置为镜像地址 |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg 可执行文件路径，也可直接加入 PATH |
| `ALLOW_PUBLIC_ACCESS` | 未设置 | 默认只允许局域网与保留地址访问；设为 `1`（或 `true`/`yes`/`on`）才放行公网地址 |
| `LOG_LEVEL` | 未设置 | 设为 `debug` 时启用 Fastify 默认逐请求日志，包含请求信息、状态码和耗时 |

示例：

```powershell
$env:FFMPEG_PATH = 'D:\ffmpeg\ffmpeg.exe'
pnpm start
```

`data/sources.json` 保存目录配置，`data/library.sqlite` 保存作品索引、收藏和翻译缓存，`data/ai.json` 保存 AI 接口配置，`data/models` 保存漫画翻译的本地 ONNX 模型，`data/cache` 保存缩略图、兼容视频和漫画译图底图。备份时停止服务后复制整个 `data` 目录。缓存可以在停止服务后单独清理，会按需重新生成；模型文件缺失时会在下次识别时自动下载。兼容视频暂不自动淘汰，请留意缓存占用。

FFmpeg 不可用时，图片、GIF 和浏览器可直接播放的视频仍然可用；视频封面显示占位图，兼容转换不可用。视频编码兼容性仍取决于设备浏览器，扩展名不能保证可播放。

## 验证

```powershell
pnpm test
pnpm test:search
pnpm build
```

测试使用临时生成的媒体文件，覆盖分组、元数据解析、搜索、目录增删改、收藏保留、离线恢复、缩略图、视频 Range 读取以及 AI 提示词拼接，不操作实际媒体库。

`pnpm test:search` 对 2,500 组生成的描述进行独立性能测试，输出索引建立和多关键词、拼音、错字搜索耗时。`pnpm test:fixtures` 可在 `.cache/preview` 生成界面验证用的风景图、GIF 和视频，不会将样例加入正式媒体库。

需要单独验证漫画识别时，运行 `pnpm exec tsx tests/manga-ocr-check.ts [图片绝对路径...]`：执行 CTD 检测与 manga-ocr 识别，缺失模型会自动下载。带框调试图和同名 JSON 写到 `test-results/manga-ocr`，加 `--full` 可输出完整 OCR 文本。

## 项目结构

```
myMediaViewer/
├── index.html                  前端入口 HTML
├── package.json                依赖与脚本（dev / build / start / serve / test / test:search / test:fixtures）
├── vite.config.ts              Vite 配置：Vue 插件、/api 代理到 3210、ES2022 构建目标
├── tsconfig.json               前端与共享代码的 TypeScript 配置（noEmit）
├── tsconfig.server.json        服务端编译配置，输出到 dist-server
├── pnpm-workspace.yaml         pnpm 构建脚本许可（esbuild、sharp、onnxruntime-node）
├── start.bat                   Windows 一键启动（pnpm start，先构建再启动）
├── .gitignore                  忽略 node_modules、构建产物、data 等
├── public/
│   └── favicon.svg             站点图标
├── shared/                     前后端共享代码
│   ├── types.ts                Source / Work / Asset / AI 翻译 / 漫画任务等公共类型
│   ├── prompts.ts              作品信息与漫画翻译的内置系统提示词
│   └── search-query.ts         搜索词解析（空格分词、#"标签" 语法）
├── server/                     Fastify 服务端
│   ├── index.ts                入口：创建应用、监听端口、启动首次扫描
│   ├── app.ts                  全部 /api 路由（含 AI 接口）与前端静态资源托管
│   ├── config.ts               环境变量、data 目录与 sources.json 读写
│   ├── access.ts               局域网 / 保留地址校验，公网默认 403
│   ├── database.ts             SQLite（node:sqlite）索引、收藏与翻译缓存读写
│   ├── scanner.ts              目录扫描：解析文件名和元文件并写入索引
│   ├── parsers.ts              Pixiv / Telegram 命名规则与元数据解析
│   ├── search.ts               搜索索引：简繁、全半角、拼音、模糊匹配
│   ├── media.ts                媒体 Range 读取、缩略图与 FFmpeg 兼容转换
│   ├── directories.ts          文件夹选择器的目录浏览接口
│   ├── log.ts                  精简日志：接口、关键操作、队列进度与报错
│   ├── ai.ts                   AI 设置、调用封装、作品信息翻译与翻译缓存
│   ├── ai/manga/               漫画图片翻译（本地识别 + AI 翻译 + 译图回填）
│   │   ├── service.ts          任务队列、模型状态、缓存与整页流水线编排
│   │   ├── models.ts           HuggingFace 模型清单、下载与文件检查
│   │   ├── detector.ts         comic-text-detector ONNX：文字框、mask 与 NMS
│   │   ├── recognizer.ts       manga-ocr ONNX：encoder + GPT-2 贪心解码
│   │   ├── pipeline.ts         识别结果过滤、置信度阈值与日漫阅读顺序
│   │   ├── erase.ts            按 mask 擦除原文并估算气泡底色
│   │   └── types.ts            检测框、mask、OCR 区域等内部类型
│   └── vendor.d.ts             opencc-js 的类型补充
├── src/                        Vue 3 前端
│   ├── main.ts                 应用入口：挂载 Vue 与路由
│   ├── App.vue                 路由出口：KeepAlive 缓存媒体库列表
│   ├── router.ts               SPA 路由与上次来源恢复
│   ├── events.ts               mitt 事件总线：作品页退出时通知列表定位作品
│   ├── route-cache-key.ts      列表实例缓存键：不同搜索会话互不覆盖
│   ├── library-session.ts      列表会话：作品页翻到相邻作品时复用当前结果
│   ├── manga-layout.ts         漫画译文的 Canvas 排版
│   ├── api.ts                  fetch 封装与公共工具
│   ├── style.css               全局样式与 Material Design 3 色彩变量
│   ├── views/
│   │   ├── LibraryView.vue     媒体库页：搜索栏、筛选菜单、作品网格、无限滚动
│   │   ├── SettingsPage.vue    设置页：媒体目录、网络、AI 与视频兼容设置
│   │   └── WorkPage.vue        作品页：独立 URL、相邻作品导航与标签搜索
│   └── components/
│       ├── WorkCard.vue        作品卡片：封面、类型徽标、收藏按钮
│       ├── ViewerDialog.vue    作品查看器：翻页、全屏、作品信息翻译与漫画译图
│       ├── SettingsDialog.vue  媒体库设置主体：页面模式与弹窗模式共用
│       ├── FolderPicker.vue    文件夹选择器：面包屑、上一级、名称筛选
│       ├── AiSettingsPanel.vue AI 设置面板：接口、模型、目标语言、参数与测试
│       └── Icon.vue            MDI 图标组件
├── tests/                      测试
│   ├── library.test.ts         主测试：分组、解析、搜索、目录、收藏、离线恢复等
│   ├── ai-prompt.test.ts       提示词拼接、追加内容与旧配置兼容
│   ├── manga-layout.test.ts    漫画译文排版测试
│   ├── manga-models.test.ts    模型自动下载与固定 encoder 加载测试
│   ├── manga-pipeline.test.ts  流水线模式与并发数的默认值、夹紧与持久化
│   ├── search-query.test.ts    搜索词解析单元测试
│   ├── library-session.test.ts 列表会话隔离与相邻作品加载
│   ├── search-benchmark.ts     2,500 组描述的搜索性能基准
│   ├── manga-ocr-check.ts      CTD + manga-ocr 手动验证，输出调试图与 JSON（裁剪带 padding，与生产一致）
│   └── preview-fixtures.ts     生成界面验证用样例媒体
├── data/                       运行时数据，已忽略提交
│   ├── sources.json            媒体目录配置
│   ├── library.sqlite          作品索引、收藏与翻译缓存
│   ├── ai.json                 AI 接口配置（含 API Token）
│   ├── models/                 漫画翻译的本地 ONNX 模型（首次识别时自动下载）
│   └── cache/                  缩略图、兼容视频与漫画译图底图
├── dist/                       前端构建产物（pnpm build 生成）
├── dist-server/                服务端构建产物（pnpm build 生成）
├── test-results/               漫画 OCR 调试输出（manga-ocr-check 生成）
└── .cache/                     开发用临时输出（如 test:fixtures 的预览样例）
```

构建产物、`data`、`.cache` 和 `test-results` 均不进入版本控制。请备份 `data` 中的目录配置、AI 配置和 SQLite 数据库；收藏记录无法通过重新扫描恢复。构建产物与缓存可重新生成，模型可重新下载。
