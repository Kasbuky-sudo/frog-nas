# 首屏加载 / First load

> 这份文档解释"第一次进游戏为什么要等"，以及 `src/preload.js` +
> `src/preload-shim.js` 这一对东西到底在治什么病。
> 数字都是在本机对 `vendor/` 实测出来的，不是估算。

## 现象

| 访问方式 | 结果 |
|---|---|
| 手机浏览器 + 内网 | 秒进 |
| 飞牛 App（内网） | 进不去 |
| 手机浏览器 + fnconnect 远程 | 进度条走得很慢，全程 **~512 KB/s**，走一会儿就不动了 |

三条竖着读，"慢"和"内网/远程"没关系，和**链路带宽**有关系：内网几十 MB/s，
一路都是缓存命中；远程只有 ~512 KB/s，而首屏要下几十 MB。

## 首屏到底要下多少

`vendor/game/js/main.min.js` 把整个启动过程写在两行字面量里：

```
RES.loadConfig("default.res.json", getResRoot())   // getResRoot() = "resource/China/"
RES.loadGroup("preload")                           // 登录/加载页
... 登录之后 ...
loadGroups("game", ["config","system","system2","mainout","sheet"]
                   (+ "music_App" when GameConfig.isAPP))
loadGroups("game", ["season" + WeatherModel.getSeasonKey()])
```

再加上 `launcher.js` 里 `manifest.initial.concat(manifest.game)` 的 17 个引擎脚本，
这就是"进游戏之前一定要拿到"的全集。实测：

| | 文件数 | 体积 | 512 KB/s 下 |
|---|---:|---:|---:|
| **阻塞集**（不拿到不进游戏） | 91 | **32.5 MB** | ~65 秒 |
| 可选集（图鉴 / 家具 / 其余季节 / 其余图片） | 3787 | 225.4 MB | ~7.5 分钟 |
| 合计 | 3878 | 258.0 MB | — |

阻塞集的构成（`node -e` 打印 `plan()` 得到）：

| 类别 | 文件数 | 说明 |
|---|---:|---|
| `js/*.js` | 17 | egret / eui / assetsmanager / dragonBones / spine … 约 4.5 MB |
| `resource/China/default.res.json` | 1 | Egret 自己的配置，**不是** `resources` 条目，所以最容易漏 |
| `eab/*.eab` | 5 | `preload` / `config` / `system` / `mainout` / `season<当前季节>` |
| `sheet/*.png + *.json` | 36 | 18 张图集，**20.3 MB**，占了阻塞集六成 |
| 字体 + 动画 + 音乐 | 32 | `sys_num_*.fnt`、猫头鹰/松鼠/乌龟/博物馆动画、`music_App` 16 首 0.6 MB |

三个容易搞错的地方，都在代码里处理了：

1. **`.eab` 才是下载单位，不是那 ~6900 个资源。**
   `default.res.json` 列了 4558 个资源，其中 692 个是 `eab_asset`——它们是打包
   在 bundle **里面**的条目，共用同一个占位 url（`preload_eab` 这种），
   **零请求**。真正过线的是 27 个 `eab/*.eab` 文件。
2. **季节组是随时钟变的。** 键是 `season`(3–5→1 / 6–8→2 / 9–11→3 / 其余→4)
   + `hoursType`(6–18→1 / 18–21→2 / 21+→3 / 其余→4)，规则逐字抄自
   `vendor/game/__offline-engine.js`。所以 `plan()` 的缓存键里必须带上季节
   （否则服务器 17:00 起就一直发 `season31`，18:00 之后进游戏的客户端的
   季节包根本不在阻塞集里）。
3. **`gameConfig.json` 刻意排除。** 它每次请求都由服务端重写 WS 地址
   （`StaticServer#serveGameConfig`）并且发 `no-cache`，预热出来的副本
   永远用不上，只会多一次必然被丢弃的请求。

## 卡在哪：一次 XHR

```
index.html
  └── <script launcher.js>            ← 普通标签
        └── XHR  GET manifest.json?v=<random>     ← 整个游戏的唯一咽喉
              └── onHttpLoad → 追加 17 个 <script> → egret.runEgret()
```

`launcher.js` 第 126 行那**一次 XHR** 是串行链上的第一环：把它按住，
17 个脚本标签一个都不会发出去。项目本来就在这个接缝上打过补丁
（`XHR_TIMEOUT_SHIM` 补 Egret 缺失的 `timeout`），所以拦它不算新增拦截面。

## 治法

`src/preload-shim.js` 作为 `<head>` 里的**第一个** script 注入（早于
`__offline-engine.js` / `__probe.js`），做三件事：

1. **同步落闸**，然后 `GET /__preload/manifest` 问服务端要清单；
2. 按一套**能在烂链路上活下来**的策略把阻塞集拉进 HTTP 缓存；
3. 拉完再放行 `launcher.js` 的 XHR —— 游戏这才开始跑，而它要的东西已经在缓存里。

这套策略里的每一条都是针对"传一会儿就不动了"来的，**不是单纯把超时加长**：

| 项 | 值 | 为什么 |
|---|---|---|
| 并发 | `2` | 浏览器默认 6 条并行，限速中继会把 6 条都饿死；2 条反而能稳定前进 |
| 停顿判定 | 20 s 无新字节 | 响应体是**流式读**的，所以"半开连接"和"只是慢"能区分开 |
| 重试 | 5 次，退避 `300ms×n` | 单个资源最大 4.14 MB（一张图集），重试很便宜 |
| **不重试 4xx** | 408/429 除外 | 404 第五次还是 404，而慢链路上 5 个来回是真金白银 |
| 断点 | `localStorage` 位图，一文件一位 | 关掉页面再进来从断点接着传，不是从 0 开始 |
| 断点失效 | 按 build 指纹 | 换包后位序含义变了，旧位图必须丢弃而不是盲信 |
| 硬上限 | 8 分钟 | 到点无条件放行 |
| 跳过按钮 | 30 秒后出现 | 再烂的链路也不能把人关在外面 |

失败一律 fail-open：没有 `fetch`/streams → 完全不介入（连 `XMLHttpRequest`
都不碰）；清单 500/空 → 开闸；超时 → 开闸。`?nopreload=1` 或
`localStorage.__frog_preload_off = '1'` 可以整个关掉。

### 进度条放在开屏声明里

`#__notice` 本来就是每次启动必看、且已经盖住整个舞台的层（z-index 2147483647），
所以进度条挂在它里面，同时把「我已阅读，进入游戏」置灰改成「预载中…」——
这就是字面意义上的"传完再进去游戏"。不去抢 z-index，也不新造第二个遮罩。

### 之后就不用加载了

二访是**纯缓存命中**，靠两件事：

* Egret **不**给资源 URL 加 `?v=`（已核对 `default.res.json` 里 0 条
  `version` 字段、`assetsmanager.min.js` / `egret.web.min.js` 里 0 处
  `Math.random`），所以缓存键就是裸路径，长期有效；
* `/resource/*` 由服务端发 `Cache-Control: public, max-age=604800`（7 天，
  `FROG_RES_MAX_AGE` 可调）。`index.html` / `gameConfig.json` / 其余
  `vendor/game` 下的文件仍然是 `no-cache`——它们被响应期改写。

阻塞集拉完后，剩下 225 MB 会在**玩家点掉声明之后**以并发 1 在后台慢慢补，
并且**只要游戏自己有请求在飞、或者页面不可见就暂停**。所以远程玩家在游戏里
每点一下，永远优先于投机预热。

## 怎么验的

```
node --test test/unit/preload.test.js          # 28 条：清单 + 闸门逻辑（vm 里跑真 shim）
node test/browser/first-load.cjs               # 24 条：真 Chromium + 真 server + 真 vendor/
node --test "test/unit/**/*.test.js"           # 157 条全绿
```

浏览器测试用 CDP `Network.emulateNetworkConditions` 限速，验四条：

1. **闸门真的按住了**——按请求**顺序**断言：`launcher.js` 的
   `manifest.json?v=` 排在第 98 个请求，而最后一个 `/resource/` 是第 96 个。
   游戏在阻塞集进缓存之前一个资源都没要过。
2. **传输是持续的**——限速下记录字节进度序列，断言"没有一次超过 6 秒没有新字节"。
   实测 32.5 MB / 11.4 s，最大间隔 1010 ms。
3. **二访零请求**——同一 context 重载，`reason === 'warm'`、
   `count === 0`、首个 `manifest.json` 之前 `/resource/` 请求数为 **0**。
4. **缺文件不卡人**——往清单里塞一个不存在的文件：只请求 1 次（不重试 5 次）、
   如实报 `partial`、照常放行。

## 没解决的

* **中继的 ~512 KB/s 上限没变。** 这个机制让首屏从"永远进不去"变成
  "65 秒，有进度、能断点、二访秒进"，但没有让链路变快。
  真要提速得动 `ui/config` 那里让 App 桌面别把游戏塞进 fnconnect 域名的
  iframe（游戏 iframe 继承的是中继域名，所有资源都走中继）——
  那是另一件事。
* **首屏 32.5 MB 是游戏自己的设计。** 图集 20.3 MB 就是 `sheet` 组，
  不管的话第一屏画不出来，能压的只有传输方式，不是集合本身。
