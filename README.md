# 拾光 · Media Garden

本地媒体查看器，使用 Vue 3、TypeScript、Vite、Fastify 和 SQLite。界面按 Material Design 3 的色彩角色、曲面、圆角、导航和状态设计，支持浅色 / 深色模式及手机布局。

## 启动

需要 Node.js 24 或更新版本、pnpm 11。FFmpeg 为可选依赖，用于视频封面和兼容版本。

```powershell
pnpm install
pnpm build
pnpm start
```

打开 `http://localhost:3210`，进入「媒体库设置」点击「添加目录」，在文件夹选择器中打开磁盘、逐级浏览文件夹，再点击「选择此文件夹」。支持面包屑返回、上一级、当前层级名称筛选和已添加目录快捷入口，无需手动输入路径。选择器浏览的是**运行服务的电脑**，手机也可以直接操作，不会上传文件。目录名称默认使用文件夹名称，可自行修改。

首次启动不预设目录。可以添加任意数量的目录，每个目录选择 Pixiv 或 Telegram 的命名规则；编辑已有目录时，点击「更改」可重新选择路径。

开发模式：`pnpm dev`，前端在 `http://localhost:5173`，Vite 将 `/api` 代理给 3210 端口。

## 使用

- **作品分组**：Pixiv 按作品 ID 合并，Telegram 按编号和年月合并；页码按数字排序。重复导出的同页保留一个展示项。Pixiv 的 WebM（包括 `_p0` 等页码后缀和大写扩展名）识别为动图；同作品同页同时存在 GIF / WebM 时优先展示 WebM，只有 WebM 或只有 GIF 也能识别。WebM 动图静音自动循环播放，媒体文件保留原位。
- **浏览**：作品列表不分页，滚动到接近底部时自动加载下一批；后台扫描完成后只刷新最新的一批并保留已加载的内容，不会把你顶回列表开头。
- **界面**：只有搜索行常驻页面顶部并铺满右侧区域，亮暗切换按钮也在这一行；媒体来源、媒体类型、模糊匹配、排序方式和时间依据收进搜索框右边的二级菜单，移动端不会挤成两行。视频与动图合并成「视频」一个筛选（动图仍照常播放）。
- **元数据**：Pixiv 优先读取下载器生成的 `-meta.json`（字段最全，含翻译标签、原图链接和 JSON 里的简介），缺失字段再用 `-meta.txt` 补齐；两种元文件都带页码后缀（如 `38757265931-134522682_p0-meta.json`）时同样识别。Telegram 侧以 txt 为主，同样支持 json；没有元文件时显示作品编号。文本编码支持 UTF-8、带 BOM 的 UTF-16 和 GB18030 回退，json 里的 HTML 简介会在显示前转成纯文本。
- **排序**：默认按收藏顺序排列，也就是文件名开头的收藏编号——Pixiv 是收藏 ID（`bmk_id`，如 `38885063179-133752873_p0.webm`），Telegram 是消息号——从大到小，与你收藏作品的先后一致；同一作品出现两个收藏编号时取较大的那个。这串编号只在同一个媒体目录内部可比：两种含义和量级都不同，所以混合显示多个目录时开关会停用并自动按发布时间排列，选中某个目录后即可按收藏顺序浏览。点开关也能随时改用发布时间，标题排序不受影响。
- **搜索**：关键词用空格分隔，所有关键词均需命中，可分布在标题、作者、标签、描述或编号中。支持部分文字、简繁体、全半角、大小写、全拼及首字母。开启「模糊匹配」后加入错漏字候选。采用 SQLite 持久化 + 内存文本索引；不在每次搜索时读取 txt。当前没有语义模型或任意同义词理解。
- **播放**：原图、GIF、浏览器支持的视频直接播放。作品查看器支持数字页码切换、方向键、自动翻页、全屏和原文件链接；手机上左右滑动图片 / 视频区域切换分 P，滑到第一张 / 最后一张后继续滑动就切到上一组 / 下一组作品（往回切会停在上一组的最后一页，只有一张媒体时同样如此）；滑动信息区等其他位置直接切换作品；桌面端按住图片拖动、方向键和左右箭头按钮行为一致，都可以一路翻到底。对不支持的视频，点击「生成兼容版本」，通过 FFmpeg 生成 H.264 / AAC MP4 缓存。
- **收藏**：整组收藏存入 SQLite，各设备共享；重新扫描和编辑同一个媒体目录的路径会保留收藏。移除目录会清理该目录索引和收藏记录，不删除原文件。
- **更新**：启动时和每 5 分钟检查一次目录，也可以手动刷新。元文件的大小和修改时间都没变就复用解析缓存，解析逻辑升级时会自动重新解析；目录离线或扫描失败时保留已有索引。

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
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg 可执行文件路径，也可直接加入 PATH |
| `ALLOW_PUBLIC_ACCESS` | 未设置 | 默认只允许局域网与保留地址访问；设为 `1`（或 `true`/`yes`/`on`）才放行公网地址 |

示例：

```powershell
$env:FFMPEG_PATH = 'D:\ffmpeg\ffmpeg.exe'
pnpm start
```

`data/sources.json` 保存目录配置，`data/library.sqlite` 保存作品索引和收藏，`data/cache` 保存缩略图及兼容视频。备份时停止服务后复制整个 `data` 目录。缓存可以在停止服务后单独清理，会按需重新生成。兼容视频暂不自动淘汰，请留意缓存占用。

FFmpeg 不可用时，图片、GIF 和浏览器可直接播放的视频仍然可用；视频封面显示占位图，兼容转换不可用。视频编码兼容性仍取决于设备浏览器，扩展名不能保证可播放。

## 验证

```powershell
pnpm test
pnpm test:search
pnpm build
```

测试使用临时生成的媒体文件，覆盖分组、元数据解析、搜索、目录增删改、收藏保留、离线恢复、缩略图以及视频 Range 读取，不操作实际媒体库。

`pnpm test:search` 对 2,500 组生成的描述进行独立性能测试，输出索引建立和多关键词、拼音、错字搜索耗时。`pnpm test:fixtures` 可在 `.cache/preview` 生成界面验证用的风景图、GIF 和视频，不会将样例加入正式媒体库。

## 项目结构

```
myMediaViewer/
├── index.html                  前端入口 HTML
├── package.json                依赖与脚本（dev / build / start / test）
├── vite.config.ts              Vite 配置：Vue 插件、/api 代理到 3210、ES2022 构建目标
├── tsconfig.json               前端与共享代码的 TypeScript 配置（noEmit）
├── tsconfig.server.json        服务端编译配置，输出到 dist-server
├── pnpm-workspace.yaml         pnpm 构建脚本许可（esbuild、sharp）
├── start.bat                   Windows 一键启动（pnpm start）
├── .gitignore                  忽略 node_modules、构建产物和 data 等
├── public/
│   └── favicon.svg             站点图标
├── shared/                     前后端共享代码
│   ├── types.ts                Source / Work / Asset 等公共类型
│   └── search-query.ts         搜索词解析（空格分词、#"标签" 语法）
├── server/                     Fastify 服务端
│   ├── index.ts                入口：创建应用、监听端口、启动首次扫描
│   ├── app.ts                  全部 /api 路由与前端静态资源托管
│   ├── config.ts               环境变量、data 目录与 sources.json 读写
│   ├── access.ts               局域网 / 保留地址校验，公网默认 403
│   ├── database.ts             SQLite（node:sqlite）索引与收藏读写
│   ├── scanner.ts              目录扫描：解析文件名和元文件并写入索引
│   ├── parsers.ts              Pixiv / Telegram 命名规则与元数据解析
│   ├── search.ts               搜索索引：简繁、全半角、拼音、模糊匹配
│   ├── media.ts                媒体 Range 读取、缩略图与 FFmpeg 兼容转换
│   ├── directories.ts          文件夹选择器的目录浏览接口
│   ├── ai.ts                   AI 设置、连通性测试、模型列表与翻译缓存
│   └── vendor.d.ts             opencc-js 的类型补充
├── src/                        Vue 3 前端
│   ├── main.ts                 挂载入口
│   ├── App.vue                 主界面：搜索栏、筛选菜单、作品网格、无限滚动
│   ├── api.ts                  fetch 封装与公共工具
│   ├── style.css               全局样式与 Material Design 3 色彩变量
│   └── components/
│       ├── WorkCard.vue        作品卡片：封面、类型徽标、收藏按钮
│       ├── ViewerDialog.vue    作品查看器：翻页、滑动、全屏、收藏、兼容版本
│       ├── SettingsDialog.vue  媒体库设置：目录增删改、局域网地址
│       ├── FolderPicker.vue    文件夹选择器：面包屑、上一级、名称筛选
│       ├── AiSettingsPanel.vue AI 设置面板：接口、模型、参数与测试
│       └── Icon.vue            MDI 图标组件
├── tests/                      测试
│   ├── library.test.ts         主测试：分组、解析、搜索、目录、收藏、离线恢复等
│   ├── search-query.test.ts    搜索词解析单元测试
│   ├── search-benchmark.ts     2,500 组描述的搜索性能基准
│   └── preview-fixtures.ts     生成界面验证用样例媒体
├── data/                       运行时数据，已忽略提交
│   ├── sources.json            媒体目录配置
│   ├── library.sqlite          作品索引与收藏
│   ├── ai.json                 AI 配置
│   └── cache/                  缩略图与兼容视频缓存
├── dist/                       前端构建产物（pnpm build 生成）
├── dist-server/                服务端构建产物（pnpm build 生成）
└── .cache/                     开发用临时输出（如 test:fixtures 的预览样例）
```

构建产物、`data` 和 `.cache` 均不进入版本控制，可以随时删除后重新生成。