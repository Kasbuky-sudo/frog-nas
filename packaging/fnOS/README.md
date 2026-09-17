# fnOS 原生应用包（.fpk）打包说明

把本项目打成飞牛 fnOS 的**原生应用**（不走 Docker）。打包产物装到 NAS 上后，
桌面会出现一个「旅行青蛙」图标，点开就是游戏。

## 结论先行：为什么不用 Docker 了

| | 原来的 Docker 版 | 现在的原生 fpk |
|---|---|---|
| 依赖 | Docker + node:22-slim 镜像 | 应用中心的 Node.js v22（`install_dep_apps`） |
| 端口 | 容器映射 8980:8980 | 直接监听 8980（`service_port`） |
| 数据位置 | 宿主 `./data` 挂载 | `${TRIM_PKGVAR}/data`（`/vol1/@appdata/frog-nas/data`） |
| 生命周期 | `restart: unless-stopped` | fnOS 托管（`cmd/main` start/stop/status） |
| 装机体验 | 用户要自己拉代码、prepare 源、build | 应用中心点安装 |

游戏本体、`src/`、`public/`、`skills/` 一律没改，换的只是外壳。运行时依赖仍然
只有 `express` + `ws`，两个都是纯 JS，所以 **x86_64 与 arm64 共用同一个包**。

## 包结构

```
packaging/fnOS/
├── manifest                     应用元数据（appname/端口/依赖）
├── ICON.PNG  ICON_256.PNG       包根图标（生成物）
├── assets/icon-source.png       图标源图（512²，白底方图）
├── config/
│   ├── privilege                只写 {"defaults":{"run-as":"package"}}
│   └── resource                 固定 {}
├── cmd/                         9 个生命周期钩子（见下）
├── ui/
│   ├── config                   桌面入口定义（端口硬编码 8980）
│   └── images/icon_{64,128,256}.png
└── scripts/
    ├── build.sh                 组装 + fnpack build + 产物自检 + 自跑验证
    ├── verify-fpk.sh            解包产物、真跑起来、打 HTTP 验收
    └── make-icons.py            源图 -> 5 个尺寸
```

打包时 `build.sh` 会组装一个**暂存目录**（`.build-staging/frog-nas/`），
再交给 `fnpack build`：

```
.build-staging/frog-nas/
├── manifest, ICON*.PNG, config/, cmd/
└── app/
    ├── ui/          ← packaging/fnOS/ui/
    └── server/      ← 仓库的 src/ public/ skills/ package.json node_modules/ vendor/
```

到真机上落成 `/vol1/@appcenter/frog-nas/{server,ui}`，
其中 `server/` 就是 `TRIM_APPDEST/server`，`ui/` 由 manifest 的
`desktop_uidir = ui` 指向。

## 打包

```bash
bash packaging/fnOS/scripts/build.sh
# → dist/frog-nas-<version>.fpk + dist/SHA256SUMS.txt
```

版本号唯一来源是 `package.json` 的 `version`。

环境变量：

- `FNPACK` — fnpack 可执行文件路径，默认 `C:/Users/User/Desktop/FNOS/fnpack`
- `DEP_APPS` — 运行依赖声明，默认 `nodejs_v22`；传 `none` 产出**去掉依赖声明的
  变体** `dist/frog-nas-<version>-cli.fpk`（见下面「CLI 装不上」一节）
- `SKIP_VERIFY=1` — 跳过打包后的"自跑验证"（不推荐，见下）
- `VERIFY_PORT` — 自跑验证用的端口，默认 `18980`（**别用 8980**，本机可能已经有
  一个在跑的实例占着）

`build.sh` 在打包前后会自检，任何一条不过就直接失败：

- `ui/config` 里不得残留 `{port}` / `{display_name}` / `{url-path}` 模板占位符
- `ui/config` 的端口必须是硬编码 `8980`，且与 manifest 的 `service_port` 一致
- manifest 必须有 `platform = all` 与 `install_dep_apps = nodejs_v22`
- `vendor/game/__offline-engine.js` 必须存在（否则先跑 `node scripts/fetch-source.js`）
- 依赖自检：在暂存目录里真的 `require('./src/server.js')` 一遍，把模块图走通
- 打完后重新解开 `.fpk`，逐个确认 `manifest` / 9 个 `cmd/*` / `app.tgz` 里的
  `server/src/server.js`、`server/vendor/game/__offline-engine.js`、
  `server/node_modules/{express,ws}`、`ui/config`、图标都在
- 确认 `app.tgz` 里没有 `app/` 前缀、没有绝对路径、没有 `..`

### 产物自跑验证（`verify-fpk.sh`）

`build.sh` 最后会自动跑一遍：把 `app.tgz` 解到 `.build-verify/`，用托管 node 以
与 `cmd/main` **完全相同的环境变量组合**把服务起起来，然后打 `/api/health`、
`/api/skills`、`/admin`、`/` 四个点，并确认 `data/save`、`data/logs` 被初始化。

单独跑：

```bash
bash packaging/fnOS/scripts/verify-fpk.sh dist/frog-nas-1.0.0.fpk 18980
```

这一步的价值是：**能在本机干掉"包看着完整、装上去起不来"这一整类问题**
（vendor 素材缺失、模块图断裂、数据目录不可写）。剩下只有 `cmd/` 路径类问题
必须上真机验——因为那取决于 `TRIM_*` 的实际值。

## ⚠️ 本机环境坑：MSYS 路径转换被关闭

这台机器的 Git Bash 下，**传给原生 exe 的 POSIX 路径不会被转换成 Windows 路径**。

给 `python.exe` / `node.exe` / `fnpack` 传 `/c/Users/User/...`，Windows 会把它
理解成 **`C:\c\Users\User\...`**，于是：

- 解包"成功"了，但文件全进了 `C:\c\` 下的幽灵目录树（实测踩出过 678MB）
- node 报 `MODULE_NOT_FOUND`，而目录看起来又是好好的
- 更坏的情况是"看起来成功了"，骗你很久

**规则**：所有交给原生 exe 的绝对路径，一律先过 `cygpath -w`。
`build.sh` / `verify-fpk.sh` 里都已经处理好了。

相关的一条：**`curl` 不能用 `-o /dev/null`**。`/dev/null` 是作为参数传给
原生的 `curl.exe` 的，同样不转换，curl 会去写一个不存在的 `/dev/null`，
报 `curl: (23) client returned ERROR on write` 并以非 0 退出——响应其实已经
拿到 200 了，但 `if curl ...` 永远判假。要丢弃响应体就用 bash 自己的重定向
`> /dev/null`（那是 bash 处理的）。

顺带：本机**没有 `pgrep` / `pkill`**（只有 NAS 上有 procps）。
所以 `cmd/*` 里用到它们的逻辑没法在本机验证，属于真机专属路径。

另外：**本机可能已经有一个 frog-nas 在 8980 上跑着**（Docker 或本地 node）。
打包和验证都别去动它。

## 真机安装与验收

### 首选：NAS 自带的 `appcenter-cli`（root，**能带依赖**）

官方文档给的 SSH 安装方式就是它。与 `trim-cli` 的关键区别：**它接受
`install_dep_apps` 的包**，装完应用中心侧的 `dependencyAppNames` 会正确变成
`["nodejs_v22"]`——也就是"安装时顺带把前置应用装上"真的生效了。

```bash
# 1. 先把 fpk 传到 NAS（SFTP / 共享目录都行，这里落在用户主目录）
#    236MB 在千兆局域网约 12s

# 2. 备份应用数据（卸载不删 @appdata，但别赌）
sudo cp -a /vol1/@appdata/frog-nas/. /vol1/1000/frog-nas-backup-$(date +%Y%m%d-%H%M%S)/

# 3. 升级必须【先卸再装】——见下面「install-fpk 对已装应用是空操作」
sudo /usr/local/bin/appcenter-cli uninstall frog-nas
sleep 8
sudo /usr/local/bin/appcenter-cli install-fpk /vol1/1000/frog-nas-1.0.0.fpk -v 1
sleep 4
sudo /usr/local/bin/appcenter-cli start frog-nas
```

权限：`appcenter-cli` 以普通用户跑会直接 `panic: dial unix
/run/trim_app_cgi/rpcbroker: connect: permission denied`，**必须 root**。

### ⚠️ `appcenter-cli install-fpk` 对已安装的同名应用是**空操作**

这是本项目踩过最隐蔽的一次假成功：应用已存在时，它只打印

```
[Info]Application [frog-nas] is installed.
```

**rc=0、无任何报错，但一个文件都没换、进程也没重启。** 光看命令输出会以为升级成功了
（同时 `trim-cli app status` 也照旧显示 `running`），只有 `/var/apps/<app>/manifest`
里的 `checksum` 能戳穿它——那个值来自包内，没变就说明包没落地。

所以升级只有一条路：`uninstall` → `install-fpk`。

另外：**`install-fpk` 自己就会 autostart**，紧跟一条 `start` 可能撞上竞态报
`[Error]Failed to launch app. error code 10500..`。这不是失败——看
`${TRIM_PKGVAR}/info.log` 里如果已经有 `started, 8980 is listening (pid=...)` 就是好的。
想稳一点就别补那条 `start`，或者先 `sleep 15` 再判断。

### 次选：`trim-cli`（只在需要出 `-cli` 变体时用）

```bash
CLI="C:\Users\User\.workbuddy\skills\trim-cli\bin\trim-cli-windows-x64.exe"

"$CLI" --profile x86nas --allow-insecure-ws app uninstall frog-nas --yes
sleep 6
"$CLI" --profile x86nas --allow-insecure-ws app install-fpk \
    "C:/path/to/dist/frog-nas-1.0.0-cli.fpk" --volume-id 1 --yes
"$CLI" --profile x86nas --allow-insecure-ws app status frog-nas
```

⚠️ 这条 `uninstall` → `install-fpk` 的路径**不会触发 `upgrade_init/upgrade_callback`**
（那是应用中心"更新"才走的）。所以升级钩子的内容都必须是"缺了也不影响启动"的幂等操作。
`appcenter-cli` 那条路同理。

### ⚠️ manifest 带 `install_dep_apps` 时，**`trim-cli`** 装不上（但 `appcenter-cli` 可以）

```
Error: app-center install has dependency app changes that require App Center UI
```

只要 manifest 里有 `install_dep_apps`，`trim-cli app install-fpk` 就会拒绝——
`--yes` / `--no-start` / `--cancel-on-failure` / `--dry-run` 全试过，没有绕过开关。

**但这只是 `trim-cli` 客户端自己的预检。** NAS 自带的 `/usr/local/bin/appcenter-cli`
（root）同一份包直接接受，装完 `dependencyAppNames` 正确。所以正式包走 `appcenter-cli`，
`-cli` 变体只是给"手上只有 `trim-cli`"的场景留的退路。

PC 上要出一个能被 `trim-cli` 装的变体：

```bash
DEP_APPS=none bash packaging/fnOS/scripts/build.sh
# → dist/frog-nas-1.0.0-cli.fpk      （正式包不受影响）
```

设计上刻意的几点：

- **正式包的 manifest 由仓库文件决定**，去掉依赖只发生在暂存副本上
  （`grep -v '^install_dep_apps'` 写进 `.build-staging/`），
  不会被一次验收构建带偏；
- 变体名带 `-cli` 后缀，不与正式包同名，避免误发；
- `install_dep_apps` 只影响"装的时候是否顺手装 Node.js"，与 `cmd/`、端口、
  `ui/config`、数据目录**全都无关** ⇒ 拿变体验出来的结论对正式包同样有效；
- 校验和把所有 `*.fpk` 一起算，第二次构建不会覆盖掉第一份。

### 安装后 `config/` 目录是 644（没有 x 位），这是正常的

fnOS 安装时会把包根的 `config/` 设成 `644 root:root`（目录没有执行位）。
同机其他的第三方应用一模一样：`lite.video` / `miyin` / `hermes-studio` 全是 644，
只有 `omni-tools` 是 755。**不是本项目的问题，别去改。**
副作用只是非 root 用户 `stat`/`cd` 不进去，`config/privilege` 由 fnOS 以 root 读取。

## 关键设计决策（都是真机上被教育出来的）

**端口 8980 在 `ui/config` 里硬编码，不用 `${port}`。**
manifest 声明了固定 `service_port` 时，fnOS **不会**给 `${port}` 赋值；而 `{port}`
这种单花括号 fnOS 根本不认——它会原样留在配置里，结果是桌面图标点了没反应。
所以 `build.sh` 里专门有两条断言盯着这件事。

**桌面入口是「页内 iframe」（`"type": "iframe"`），且服务端刻意不发 `X-Frame-Options`。**

`ui/config` 的 `type` 决定点图标后怎么打开：`url` = 新标签页，`iframe` = 嵌进飞牛桌面。
飞牛拼出来的地址是 `{protocol}://{当前浏览器 hostname}:{port}{url}`，桌面在 `:5666`、
应用在 `:8980` —— **端口不同即跨源**。跨源 iframe 下，只要响应里带
`X-Frame-Options: SAMEORIGIN`，浏览器就直接拒绝渲染：

> 症状是**「页内打开一片空白，切到新标签页打开却完全正常」**。
> 因为改 `type` 之前一直是 `url`，这个坑在切换的那一刻才会现形，非常容易被当成前端 bug。

`X-Frame-Options` 只有 `DENY` / `SAMEORIGIN` 两个取值，表达不了"放行某个跨源祖先"，
所以 `src/static.js` 的 `commonHeaders()` **不发它**，白名单交给 CSP 的
`frame-ancestors 'self' http: https:`。回归测试在 `test/unit/static.test.js`：
「iframe: 不发 X-Frame-Options，且 CSP 放行 frame-ancestors」。

改完 `ui/config` 后如果桌面上没变化，重启应用中心让它重读：
`sudo systemctl restart trim_app_center.service`（服务名就是 `trim_app_center`）。

⚠️ 已知边界：通过 **HTTPS(:5667)** 访问桌面时，`protocol: http` + `:8980` 的 iframe
属于**混合内容**，会被浏览器拦掉。根治要走飞牛的「统一网关」
（`protocol: ""` + `gatewayPrefix` + `gatewaySocket`，nginx 同源反代到应用自建的
unix socket，同机的 `miyin` 就是这个形态）——那时 iframe 与桌面同源，
`X-Frame-Options: SAMEORIGIN` 反而可以留着。改动涉及 `cmd/main` 起 socket 与处理
`/app/frog-nas/` 前缀，本版未做。详见 `docs/decisions.md` 的 D68 / L8。

**路径一律从 `/var/apps/<app>/target` 反推，不写死 `/vol1`。**
数据卷可能是 `/vol1`/`/vol2`/…，写死会找错卷。`cmd/main` 优先用 fnOS 注入的
`TRIM_*`，缺失或指向不存在的目录时才从软链解析，解析失败就直接报错退出（不静默兜底）。

⚠️ **兜底必须落在 `target` 上，不能落在 `/var/apps/<app>` 上。**
`/var/apps/<app>` 本身是**真目录**（装 `cmd/`、`config/`、`manifest`），
`readlink -f` 对真目录返回**它自己**、不穿透。于是
`APP_DIR` 会被拼成 `/var/apps/<app>/server` —— 一个**根本不存在的路径**：

- `status`/`stop` 的进程特征串与真实 cmdline（`@appcenter` 路径）对不上；
- `start` 会 `cd` 到不存在的目录直接失败。

真机实测：不注入 `TRIM_*` 跑 `cmd/main status` 返回 **3**（进程明明在跑）。
fnOS 正常会注入正确的 `TRIM_APPDEST`，所以这个 bug 只在"兜底路径被走到"时现形。

真机布局已实证（2026-09-17，x86NAS）：

```
/var/apps/frog-nas/                  ← 外壳，内容：cmd/ config/ ICON* manifest + 软链
   target -> /vol1/@appcenter/frog-nas   ← app.tgz 就解到这里
   var    -> /vol1/@appdata/frog-nas     ← TRIM_PKGVAR，存档在这
   home   -> /vol1/@apphome/frog-nas
   meta   -> /vol1/@appmeta/frog-nas
   etc    -> /vol1/@appconf/frog-nas
   tmp    -> /vol1/@apptemp/frog-nas

TRIM_APPDEST = /vol1/@appcenter/frog-nas
   └── server/    ← src/ public/ skills/ package.json node_modules/ vendor/
   └── ui/        ← desktop_uidir
```

所以 `APP_DIR="${TRIM_APPDEST}/server"`，**不多不少一层**（`target` 只是
`/var/apps/<app>/` 里的软链，不是额外目录层级）。同机在跑的 `miyin` 用的就是
这个写法，它的实际进程是 `/vol1/@appcenter/miyin/server/.output/server/index.mjs`。

Node 运行时的落地形式同理：`/var/apps/nodejs_v22/target/bin/node`
= `/vol1/@appcenter/nodejs_v22/bin/node`。用 `/var/apps/<dep>/target/...` 定位
运行时是**卷位置无关**的，比硬编码 `/vol1` 干净。

**进程特征串用 `server.js` 的绝对路径，且 `pgrep/pkill` 一律加 `--`。**
模式串以 `-` 开头会被 procps 当成选项而报 `invalid option`，兜底判断和兜底清理
会静默失效。用绝对路径还顺带避免了误杀其他应用的 node 进程。

**`cmd/main` 用 `exec` 让 node 顶替内层 bash，pidfile 里才是 node 的真 pid。**
否则写进去的是 `runuser`/`bash` 包装层的 pid，`stop` 杀不干净，端口一直被占。

**钩子里绝不出现 `$0`。** 用 `"${CMD_DIR}/main"` 显式调用。钩子里的 `$0` 指向
钩子自身，拿它去执行会把整个流程递归跑一遍（历史上真机上一次卸载炸出过 5888 个进程）。

**`status` 的约定是运行中 `exit 0`、未运行 `exit 3`**，不是 1。写错会导致
fnOS 误判"没起来"从而重复拉起第二个实例抢端口。

**判定进程存活不能用 `kill -0`，要用 `/proc/<pid>`。**
以非属主身份调用时，`kill -0` 对**活着的**别人的进程返回 EPERM（rc=1），
在 shell 里与"进程不存在"（ESRCH）完全没法区分。原实现据此判定"已退出"后
会顺手 `rm -f` 掉 pidfile —— 结果就是：**以普通用户跑一次 `cmd/main status`，
`app.pid` 就没了**（真机上被自己的验收脚本这么坑过）。
现在用 `[ -d /proc/<pid> ]` + 读 `/proc/<pid>/cmdline` 校验，并排除僵尸态 `Z`；
**只有确认 pid 真的不存在时才清 pidfile**。

> 顺带一条操作纪律：**别以非属主用户去跑 `cmd/main status`**。
> 修复前它会删 pidfile；修复后虽然安全了，但 `status` 在权限受限时本来就
> 只能用 `/proc` 兜底，不如直接用 `sudo` 或让 fnOS 调。

**不注入 `FROG_*` 环境变量。** `src/server.js` 的 `envWithOverrides()` 让真实环境变量
盖过 `data/config.json`，一旦在启动脚本里写死 `FROG_FAITHFUL` 等，`/admin` 设置页里
改的时长就永远不生效。启动脚本只注入 `TZ` / `NODE_ENV` / `PORT` / `HOST` / `FROG_DATA_DIR`。

**`install_dep_apps = nodejs_v22`。** 包体因此不含 Node 运行时（省掉约 180MB）。
`cmd/main` 按 `nodejs_v22` → `nodejs_v24` → `PATH` 的顺序找 node，
都找不到就写一条人能看懂的错误再失败。

## 数据与升级

| 用途 | 路径 |
|---|---|
| 存档 | `${TRIM_PKGVAR}/data/save/` |
| 配置（API token、推送、引擎参数） | `${TRIM_PKGVAR}/data/config.json` |
| 日志 | `${TRIM_PKGVAR}/info.log`（生命周期）、`${TRIM_PKGVAR}/data/logs/`（应用） |
| 升级前快照 | `${TRIM_PKGVAR}/backups/pre-upgrade-<时间戳>/`（保留最近 3 份） |

`TRIM_PKGVAR` 即 `/vol1/@appdata/frog-nas`，**与应用目录分离**，所以升级覆盖
`app/` 不会影响进度。`upgrade_init` 会在替换程序前把 `config.json` + `save/`
快照一份。

**卸载不会主动删数据。** 程序目录会被移除，`@appdata/frog-nas/data` 里的存档
是否保留由 fnOS 决定；`cmd/uninstall_callback` 刻意不做任何删除动作，
要彻底清除请手动删除该目录。

## 已知边界

- **`vendor/` 是 274MB 的游戏源，会被打进包**（`/dist` 与 `.build-staging/`
  已在 `.gitignore` 里）。这也是包体积的主要来源。
- `vendor/` 更新后必须重打包：`node scripts/fetch-source.js && bash packaging/fnOS/scripts/build.sh`。
- 图标改了源图要重跑 `make-icons.py` 再打包，否则那 5 个尺寸文件不会被更新。
