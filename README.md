# 旅行青蛙 · NAS 版

把《旅行青蛙·中国之旅》的**离线安卓包**移植成一个跑在 NAS 上的
Docker 单容器网页应用，并加上两个原版没有的能力：**外部消息推送**与
**AI Agent 操作接口（Skills）**。

> **NAS / Docker 移植：Kasbuky** · 游戏著作权归 Hit-Point Co., Ltd. ·
> 离线版由 Balticx 制作

游戏逻辑**一行未改**：随包的离线引擎是唯一权威，客户端 JS 也原样托管。
本项目只做三件事——把引擎搬到服务器上跑、把浏览器变成它的一个视图、
在引擎外面接出推送与 REST。

```
浏览器 ──HTTP──▶ Express(8980)
  │  /            → vendor/game/index.html（注入 Route A 开关）
  │  /resource/*  → vendor/resource/China/*
  │  /admin       → 设置页（推送 / token / 时长 / 存档）
  ├─WS /ws───────▶ WS 桥 ──▶ 引擎宿主（vm 沙箱 + 磁盘存档）
  │                                ▲
AI/外部程序 ─Bearer─▶ /api/* ── Bot 客户端（同一套 wire 协议）
                                  状态差分 → 事件 → 推送（Webhook / MeoW）
```

> **免责声明**
> 本程序为个人发起的**非商业性**游戏保存与研究项目，基于《旅行青蛙》
> （原著作权人：**Hit-Point Co., Ltd.**）制作。游戏代码、美术素材、音乐音效、
> 文本内容及其衍生部分的著作权均归原著作权人及相关权利人所有。
> 本项目**不出售、不出租、不接受捐赠、不附带广告或任何形式的变相收费**，
> 唯一目的是避免该作品因停运而被完全遗忘。离线版由 **Balticx** 制作，
> 游戏页面内的权利归属声明弹层每次启动都会显示，请勿移除。
> 游戏源文件不纳入版本控制（见 `.gitignore` 的 `vendor/`）。

---

## 快速开始

> **飞牛 fnOS（NAS）用户看这里**：本项目现在也提供**原生 `.fpk` 应用包**，
> 不需要 Docker，运行时直接用应用中心的 Node.js v22，一个包同时支持 x86_64 与 arm64。
> 打包与安装说明见 **[`packaging/fnOS/README.md`](packaging/fnOS/README.md)**。
> 装好后在飞牛桌面点「旅行青蛙」图标，**游戏直接嵌在桌面窗口里打开**（页内 iframe，
> 不跳新标签页）。
> 下面的 Docker 路径依然可用，两条路并存、数据目录不同（原生包的数据在
> `/vol1/@appdata/frog-nas/`）。

### 0. 你需要什么

- 一个解包后的 APK 目录（含 `assets/game/` 与 `resource/China/`）
- Node.js 22+（只用来跑准备的脚本；运行时在容器里）
- Docker + Docker Compose（NAS 上）
  —— **飞牛 fnOS 走原生包的话这两样都不需要**

### 1. 准备游戏源

游戏源不进仓库，先用脚本从解包目录拷出所需子集：

```bash
# Windows
.\scripts\fetch-source.ps1 -Src "D:\Downloads\com.frog.offline"

# Linux / macOS / NAS 上的 shell
./scripts/fetch-source.sh --src /volume1/apk/com.frog.offline

# 或者直接指定
node scripts/fetch-source.js --src /path/to/com.frog.offline
```

脚本只拷 `assets/game/` 与 `resource/China/`，**不拷**安卓壳
（`AndroidManifest.xml`、`classes.dex`、`res/`、`META-INF/`、`resources.arsc`），
并在结束时自己校验这一点。产出约 264MB。

### 2. 启动

```bash
docker compose up -d --build
```

### 3. 打开

| 地址 | 用途 |
|---|---|
| `http://<NAS_IP>:8980` | 游戏（先看到权利声明，点「我已阅读，进入游戏」开始） |
| `http://<NAS_IP>:8980/admin` | 设置页：推送、API token、引擎时长、存档 |
| `http://<NAS_IP>:8980/api/health` | 健康检查（免认证） |
| `http://<NAS_IP>:8980/api/openapi.json` | 接口文档 |

进度存在 `./data/`，重建容器不会丢。

---

## 源获取与更新

`vendor/` 是生成物，**更新游戏源后重跑 `fetch-source` 再重建镜像**即可：

```bash
node scripts/fetch-source.js --src /path/to/new/com.frog.offline
docker compose up -d --build
```

- 不加 `--force` 是增量覆盖；换了源包（有文件被删掉）时加 `--force`，
  否则旧文件会残留并继续被托管。
- 存档在 `data/`，与 `vendor/` 无关，更新源不会影响进度。
- 脚本会保留一份 `vendor/gameConfig.original.json`，服务端每次改写
  `gameServer` 都从这份原版字节出发。

---

## 玩起来是什么样

- **服务端权威**：引擎只在容器里跑一份，手机和电脑同时打开看到的是同一个世界。
  一个标签页收草，另一个标签页 30 秒内也会变。
- **原版时长**：默认 `FROG_FAITHFUL=1`，按 `define.json` 里恢复的原版服务端数值
  旅行（小时级）。想在一次坐下里玩完，去设置页把它改成 `0`。
- **关掉浏览器也会继续**：引擎的时钟在服务端跑，所以蛙会照常出门、回家、
  收邮件——这正是推送有意义的前提。
- **多端同步**：所有引擎消息 fan-out 给全部连接，包括别的标签页触发的动作。

---

## 推送配置

支持两个通道，可同时开、可分别订阅事件。

### 通道 A：自定义 Webhook

设置页填 URL 即可。默认会 POST 这样一份 JSON：

```json
{
  "event": "depart",
  "title": "青蛙出发了",
  "body": "蛙背上行囊出门了，去哪儿还不知道——等它的明信片吧。",
  "timestamp": "2026-09-17T10:00:27.000Z",
  "url": "http://nas:8980/",
  "image": "http://nas:8980/asset/postcard/100",
  "data": { "departAt": 1789639228, "tripCount": 1 }
}
```

- 想验证的话，去 [webhook.site](https://webhook.site) 拿一个地址填进去，
  点「发送测试推送」，再把 `depart` / `postcard` / `return` / `visitor_*` 勾上，
  等蛙出门。
- 可以自定义请求头（填 JSON）与 body 模板，占位符：
  `{{event}} {{title}} {{body}} {{timestamp}} {{url}} {{image}} {{data}} {{dataJson}}`。
- `{{data}}` 单独占一个值时是嵌套 JSON 对象；写在引号里会被转义成字符串。

### 通道 B：鸿蒙 MeoW

[MeoW](https://www.chuckfang.com/MeoW/api_doc.html) 用**昵称**作为收件标识，
没有 token，所以只需要填对昵称：

1. 在 MeoW 里确认你的**昵称**（不是手机号、不是设备名）。
2. 设置页勾选启用，填入昵称。
3. 点「发送测试推送」，手表/手机应当立刻收到。

成功判据是 MeoW 响应体里的 `status === 200`（服务端会用 HTTP 200 包着
"昵称不存在"这类业务错误，所以只看 HTTP 状态码会误判成功）。

### 事件订阅与免打扰

可订阅：`depart` 出发、`postcard` 明信片、`return` 回家（附带回清单）、
`visitor_arrive` 访客到访、`visitor_gift` 访客回礼、`mail` 新邮件、
`lottery` 券够了、`title_unlock` 新称号、`furniture_finish` 家具完成。
默认开前五个。

免打扰默认 23:00–07:00：**期间的事件排队，窗口结束后补发**（不丢）。
失败重试默认 3 次，指数退避 2s/4s/8s。所有发送记录在
`data/logs/push.jsonl`，设置页可查看最近 100 条。

### 明信片图片

推送里的 `image` 指向 `/asset/postcard/<picId>`，由服务端用**游戏自己的美术**
现场合成 500×350 的 PNG（与客户端 `drawToTexture` 同一尺寸）。
这个地址不带鉴权，因为 MeoW / webhook 接收方要自己来取图；
它只暴露本来就从 `/resource/China` 公开可访问的素材。

要让 `url`/`image` 是绝对地址，得告诉服务端你从外面怎么访问它——
设置页的「对外地址」或 compose 里的 `PUBLIC_URL`：

```yaml
environment:
  PUBLIC_URL: "http://192.168.1.10:8980"
```

---

## 给其他 AI 装 Skills

`skills/` 下有 5 个技能，每个是一份自包含的 `SKILL.md`：

| 技能 | 何时用 |
|---|---|
| `frog-status` | **每次操作前先查**：蛙在哪、草熟没熟、券够不够、有没有客人 |
| `frog-harvest` | 收三叶草（先查总览判断有没有熟的） |
| `frog-prepare` | 备行李：查库存 → 缺便当先买 → 装背包 → 可选放桌 |
| `frog-visitor` | 发现访客并按口味投喂、追踪回礼 |
| `frog-lottery` | 券够 5 张则抽，否则说明券的来源 |

### 1. 提供连接信息

技能用两个环境变量（缺失时会问你）：

```bash
export FROG_API_BASE="http://192.168.1.10:8980"   # 只需要这一个
```

**默认不需要 API token**：agent 知道地址就能用。只有当 8980 可能被不信任的设备访问时，
才需要去 `/admin` 打开「要求 token」，那时才要 `FROG_API_TOKEN`。

### 2. 装进客户端

**Claude Code / ZCode 这类支持 Skills 的客户端**：把 `skills/` 下的目录整个
拷进技能的搜索路径（例如 `~/.claude/skills/` 或 `~/.zcode/skills/`）：

```bash
cp -r skills/* ~/.zcode/skills/          # 按你的客户端调整目标目录
```

**其他 Agent / 脚本**：直接读正文即可，在线也能拿：

```bash
curl -s http://<NAS_IP>:8980/api/skills                      # 清单
curl -s -H "Authorization: Bearer $FROG_API_TOKEN" \
     http://<NAS_IP>:8980/api/skills/frog-status             # 单个技能正文
curl -s http://<NAS_IP>:8980/skills/frog-status/SKILL.md     # 原始 markdown
```

每份技能里的 `curl` 示例都是**原样可执行**的，字段说明取自真实响应。
`test/unit/skills-consistency.test.js` 会解析这些文档里的路径与字段，
和真实路由逐条比对——所以技能不会悄悄和接口脱节。

### 3. 一次典型对话

> 你：看看蛙在干嘛
>
> AI：（`frog-status`）蛙现在在家看书，院子 20 株草都熟了，有 2 封邮件没拆。
>
> 你：收草，然后给它备点东西出门
>
> AI：（`frog-harvest` → `frog-prepare`）收了 20 株三叶草（1 株四叶草）。
> 便当、护身符、两件工具都装好了。**出发时间是它自己定的**，出门后我推给你。

---

## 目录结构

```
.
├── Dockerfile / docker-compose.yml
├── package.json                # 依赖只有 express + ws
├── scripts/
│   ├── fetch-source.js/.ps1/.sh   # 从解包目录取所需子集到 vendor/
│   └── network-audit.js           # 生成 docs/network-audit.md
├── src/
│   ├── server.js               # 入口：静态映射 + 注入 + WS + 世界时钟
│   ├── static.js               # 路径映射、gameConfig 改写、index 注入、CSP
│   ├── engine-host.js          # vm 沙箱加载引擎 + 磁盘 localStorage
│   ├── ws-bridge.js            # /ws 桥：客户端 ⇄ 引擎，多端 fan-out
│   ├── bot.js                  # 进程内 bot：握手 + 高层动作 → wire 指令
│   ├── gamedata.js             # 从引擎 bundle 里只读提取配表
│   ├── state-view.js           # 引擎状态 → /api/state 投影
│   ├── postcard.js             # 明信片 PNG 合成（zlib，无第三方依赖）
│   ├── openapi.js              # /api 的 OpenAPI 文档
│   ├── skills.js               # 读取 skills/*/SKILL.md
│   ├── settings.js / admin.js  # data/config.json 读写 + 设置页
│   ├── api/index.js            # REST 路由
│   └── push/                   # events / webhook / meow / dispatcher
├── public/admin.html           # 设置页（原生 JS，无构建）
├── skills/                     # 5 个 SKILL.md
├── docs/                       # source-map / protocol / decisions / network-audit
├── test/                       # node:test 单测 + 集成
└── vendor/                     # .gitignore；fetch-source 生成
```

---

## 开发

```bash
npm install
node scripts/fetch-source.js      # 准备 vendor/
npm start                         # 本机起在 8980
npm test                          # 全部测试（140 个）
npm run test:unit                 # 只跑单测
npm run audit:network             # 重新生成网络审计报告
```

测试分三层：

- **单测**（`test/unit/`）：磁盘 localStorage 适配器、gameConfig 改写、
  webhook 模板渲染、MeoW 请求构造、事件差分、以及
  **OpenAPI ↔ 路由 ↔ SKILL.md 三方一致性**。
- **集成**（`test/integration/`）：真实引擎的完整生命周期（含"断电重启后
  时间线补结算"）与一个**真实子进程服务器**上的完整游戏循环
  （收草 → 购买 → 装包 → 出发 → 明信片 → 访客 → 投喂 → 回礼），
  同时用本地 HTTP 接收端断言推送载荷与顺序。
- **手工冒烟**（`test/manual/`）：勘察与调试用的一次性脚本，不参与 CI。

集成测试用 `FROG_FAITHFUL=0` 加缩短时长，所以整个循环能在秒级跑完；
生产默认仍是原版时长。

---

## 安全提醒

- `/admin` 会**显示 API token**。默认没有访问码，请勿把 8980 直接暴露到公网。
  放到反代后面时建议在 `/admin` 里设置访问码。
- 容器唯一的出站流量是推送（你配置的 webhook 与 `api.chuckfang.com`），
  详见 [docs/network-audit.md](docs/network-audit.md)；游戏页面还带一层
  `default-src 'self'` 的 CSP 兜底。
- 游戏包内的渠道 SDK（ejoySDK 等）代码仍在，但 CSP 会让它们无法外联。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/source-map.md](docs/source-map.md) | 源包每个文件的作用、哪些被丢弃、引擎内部结构 |
| [docs/protocol.md](docs/protocol.md) | wire 信封、握手时序、REST↔指令映射、推送事件表 |
| [docs/decisions.md](docs/decisions.md) | 67 条自行决策与 7 条已知限制 |
| [docs/acceptance.md](docs/acceptance.md) | 验收清单的逐项自查（含未验证项与镜像体积实测） |

## 进设置页

游戏里右侧的**「推送设置」**按钮就是设置入口（`/admin`）：推送、API token、
引擎时长、存档都在那里。

那个位置原本是**「公告」**按钮，打开的是公告列表——而这份列表由服务端推送，
在本项目里恒为空（引擎里没有任何公告数据源，客户端填充列表走的是 Ejoy 原生 SDK 桥，
浏览器里是空操作）。所以它本来就是个永远没内容的空面板，现在改为在原位跳设置页。

旁边的**「编辑」**按钮打开存档编辑器（改三叶草/抽奖券、解锁图鉴、立刻出门、
导出/导入存档等）。它原本是「做贺卡」之一；同排的**「春联贺卡」和「做蛋糕」已隐藏**。

设置页标题栏有「← 返回游戏」，往下滚还会浮出一个固定按钮，两条路都能回游戏。

## 支持哪些架构

**x86_64 和 arm64 都支持，开箱即用**——因为整个项目没有一行平台相关代码：

- 运行时依赖只有 `express` 和 `ws`，两个都是**纯 JavaScript**（无原生扩展、
  无 `binding.gyp`、无安装脚本）。锁文件里 70 个包，`hasInstallScript` 数量为 **0**。
- 明信片图片合成用的是 Node 内置 `zlib` + 自写的 PNG 编解码，没有引入任何图像库。
- 基础镜像 `node:22-slim` 官方同时提供 `linux/amd64` 与 `linux/arm64`。
- 游戏本体是纯前端资源，与架构无关。

所以在群晖/威联通/飞牛（ARM 机型也可以）上：

```bash
docker compose up -d --build     # 自动匹配本机架构
```

想显式指定或做多架构构建：

```bash
docker build --platform linux/arm64 -t frog-nas:1.0.0 .
docker buildx build --platform linux/amd64,linux/arm64 -t frog-nas:1.0.0 .
```

验证镜像架构：`docker inspect frog-nas --format '{{.Architecture}}'`，
或 `docker image inspect frog-nas --format '{{.Os}}/{{.Architecture}}'`。

**原生 `.fpk` 包同样是一个包通吃两个架构**（manifest 里 `platform = all`）。
这不是"看起来应该可以"，而是对产物逐条扫过的：

- 包内 `*.node` / `*.so` / `*.dll` / `*.dylib` / `*.exe`：**0 个**
- `prebuilds/` 或 `build/Release/` 目录：**0 个**
- 顶层依赖里带 `gypfile` 或 `install`/`postinstall` 脚本的：**0 个**
- 对 `node_modules/` 下所有文件按文件头判 ELF / PE / Mach-O：**0 个命中**

也就是说包里只有 JS、PNG、MP3、JSON，没有任何一行与 CPU 架构有关的东西。
运行时由应用中心的 `nodejs_v22` 提供，它在 x86 与 ARM 两个商店里都有对应构建
（ARM 版是 `22.22.0-1`）。

**唯一需要注意的**：如果 NAS 上的旧 npm 缓存里混进过原生模块（例如别的项目留下的
`better-sqlite3`），`npm install` 可能报错或留下无用产物。本项目**不用任何数据库**，
干净构建即可——Dockerfile 里已经是 `npm install --omit=dev`，只装那两个依赖。

游戏本身是**竖屏设计**（640×1136，原版 APK 也是锁竖屏的）。在宽窗口里它保持
「完整竖屏画面居中，两侧留白」，而不是重排成横屏 UI。

有一个坑已经修好了：`index.html` 只在**页面加载时**按窗口宽高比选一次缩放模式，
之后再不改。所以"竖屏打开再转横屏"曾经会只显示设计高度的三分之一、底部按钮全部
点不到。现在响应期注入的一段 shim 会在 `resize` / `orientationchange` 时用同一条
规则重算，转屏前后都完整可玩（实测：竖屏 → 横屏 → 竖屏 → 快速连转 4 次，零报错）。
| [docs/network-audit.md](docs/network-audit.md) | 包内全部 URL 字面量的用途审计（脚本生成） |

## 许可与致谢

- 《旅行青蛙》著作权归 **Hit-Point Co., Ltd.** 所有。
- 离线版由 **Balticx** 制作，游戏页面内的权利归属声明原样保留。
- **NAS / Docker 移植版由 Kasbuky 制作**（本项目：服务端权威的容器化移植、
  外部推送、AI Agent 接口与 Skills）。
- 本项目仅用于个人学习与游戏保存研究，非商业用途，不提供任何形式的收费。

镜像元数据（作者等）写在 `Dockerfile` 的 `LABEL` 里，可以这样查看：

```bash
docker inspect frog-nas --format '{{json .Config.Labels}}' | python -m json.tool
```
