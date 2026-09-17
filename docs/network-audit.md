# 网络审计 / Network audit

> 由 `npm run audit:network` 生成，不要手工编辑。生成时间：2026-09-17T10:01:41.592Z

## 这个文件在证明什么

本项目在 NAS 上运行一个离线游戏，要求**容器唯一的出站流量是推送**。
游戏包本身是完整离线版，但里面仍然带着若干渠道 SDK 的代码与绝对 URL。
本审计把 `vendor/` 里所有 `http(s)://` 字面量列出来，逐个说明用途与
为什么不会被触发。真正执行"禁止外联"的是响应头里的 CSP
（见 `src/static.js` 的 `cspHeader()`：`default-src 'self'`、
`connect-src 'self' ws: wss:`，没有任何第三方主机）——
即使某段 SDK 代码真的被走到，浏览器也会拒绝请求。

## 结论

共发现 **40** 处 URL 字面量，涉及 **20** 个主机，
全部已分类，没有未分类项。

| 主机 | 处数 | 性质与是否会真的请求 |
|---|---:|---|
| `github.com` | 6 | 三方库源码/文档链接（assetsmanager、dragonBones 注释） |
| `mmocgame.qpic.cn` | 6 | 微信小游戏分享图（WXgame 渠道专用，未进入） |
| `gm.mmstat.com` | 3 | 阿里埋点统计（渠道 SDK，未进入） |
| `ns.egret.com` | 3 | Egret EUI 的 XML 命名空间（eui.min.js 的 xmlns），不是网络请求 |
| `ali-lxqw-hotfix.ejoy.com` | 2 | Ejoy 热更 launcher（index.html 里那行已被离线版注释掉） |
| `jonnyreeves.co.uk` | 2 | smoothscroll 库的作者链接（注释） |
| `stuk.github.io` | 2 | JSZip 文档链接（注释） |
| `general.aligames.com` | 2 | 阿里游戏协议页（渠道 SDK，未进入） |
| `appeal.lingxigames.com` | 2 | 灵犀申诉页（渠道 SDK，未进入） |
| `localhost` | 2 | 调试用的本机地址（P10075 本地调试分支） |
| `dragonbones.com` | 1 | DragonBones 官网链接（注释） |
| `feross.org` | 1 | buffer 库的作者链接（注释） |
| `image.9game.cn` | 1 | 九游渠道 SDK 资源（未进入） |
| `www.apache.org` | 1 | Apache-2.0 许可证地址（注释） |
| `cdn.jsdelivr.net` | 1 | eruda 调试面板（ejoySDK 的调试分支，未进入） |
| `p10075-gangplank.ejoy.com` | 1 | Ejoy 埋点（渠道 SDK，未进入） |
| `www.w3.org` | 1 | XHTML/XML 命名空间标识符（jszip），不是网络请求 |
| `www.lingxigames.com` | 1 | 灵犀保护页（渠道 SDK，未进入） |
| `ali-x3-srv01.x3.ejoy.com` | 1 | Ejoy 远程包地址（渠道 SDK，未进入） |
| `render.aligames.com` | 1 | 阿里游戏防沉迷页（渠道 SDK，未进入） |

### 运行时实际会发出的请求

| 方向 | 目标 | 何时 |
|---|---|---|
| 浏览器 → 服务器 | 同源 `http://<nas>:8980/**` | 加载游戏 |
| 浏览器 → 服务器 | 同源 `ws://<nas>:8980/ws` | 游戏过程中持续 |
| 服务器 → 外网 | 设置页填写的 webhook 地址 | 仅在启用并发生事件时 |
| 服务器 → 外网 | `api.chuckfang.com`（MeoW） | 仅在启用推送时 |

除此之外没有出站流量：推送是仅有的两项，且都必须由用户在设置页显式启用。
注意这两项都由 **Node 服务端**发起，浏览器不会直连它们，
所以 CSP 不需要（也不应该）放行这些主机。

## 逐条明细

共 40 处，涉及 7 个文件。

| 文件 | 行 | URL |
|---|---:|---|
| `vendor\game\index.html` | 221 | `https://ali-lxqw-hotfix.ejoy.com/c1_client/release/lingxi/android/launcherv2.js` |
| `vendor\game\js\assetsmanager.min.js` | 1 | `https://github.com/egret-labs/resourcemanager/blob/master/docs/README.md#processor` |
| `vendor\game\js\assetsmanager.min.js` | 1 | `https://github.com/egret-labs/resourcemanager/blob/master/docs/README.md#processor` |
| `vendor\game\js\dragonBones.min.js` | 1 | `http://dragonbones.com/` |
| `vendor\game\js\dragonBones.min.js` | 1 | `https://github.com/DragonBones/` |
| `vendor\game\js\dragonBones.min.js` | 1 | `https://github.com/DragonBones/Tools/` |
| `vendor\game\js\ejoySDK.min.js` | 6 | `http://feross.org` |
| `vendor\game\js\ejoySDK.min.js` | 9 | `https://image.9game.cn/s/uae/g/3b/aligames/wegame-game-jssdk/2.9.4/dist/` |
| `vendor\game\js\ejoySDK.min.js` | 14 | `http://www.apache.org/licenses/LICENSE-2.0` |
| `vendor\game\js\ejoySDK.min.js` | 26 | `http://github.com/jonnyreeves/js-logger` |
| `vendor\game\js\ejoySDK.min.js` | 27 | `http://jonnyreeves.co.uk/` |
| `vendor\game\js\ejoySDK.min.js` | 31 | `http://github.com/jonnyreeves/js-logger` |
| `vendor\game\js\ejoySDK.min.js` | 32 | `http://jonnyreeves.co.uk/` |
| `vendor\game\js\ejoySDK.min.js` | 34 | `http://gm.mmstat.com/` |
| `vendor\game\js\ejoySDK.min.js` | 34 | `https://gm.mmstat.com/` |
| `vendor\game\js\ejoySDK.min.js` | 34 | `http://gm.mmstat.com/` |
| `vendor\game\js\ejoySDK.min.js` | 34 | `https://cdn.jsdelivr.net/npm/eruda` |
| `vendor\game\js\ejoySDK.min.js` | 34 | `https://p10075-gangplank.ejoy.com/gp/p10075/notify/ag` |
| `vendor\game\js\eui.min.js` | 6 | `http://ns.egret.com/eui` |
| `vendor\game\js\eui.min.js` | 6 | `http://ns.egret.com/wing` |
| `vendor\game\js\jszip.min.js` | 2 | `https://stuk.github.io/jszip/documentation/howto/read_zip.html` |
| `vendor\game\js\jszip.min.js` | 5 | `https://stuk.github.io/jszip/documentation/howto/read_zip.html` |
| `vendor\game\js\jszip.min.js` | 7 | `http://www.w3.org/1999/xhtml` |
| `vendor\game\js\main.min.js` | 2 | `https://mmocgame.qpic.cn/wechatgame/y95m3WtbN0UUEbL7I7cvQl7UMpOfrpKysUcHzVEXvrotdtDvVB2...` |
| `vendor\game\js\main.min.js` | 2 | `https://mmocgame.qpic.cn/wechatgame/y95m3WtbN0XOYPYbA6T49cSqfvwoOwMSpMCkia5ax0U2HFwtkVi...` |
| `vendor\game\js\main.min.js` | 2 | `https://mmocgame.qpic.cn/wechatgame/y95m3WtbN0Wl4R2l1kDgJeNhAVgKDlO56ZMkuAIzEcu4aIPibde...` |
| `vendor\game\js\main.min.js` | 2 | `https://mmocgame.qpic.cn/wechatgame/y95m3WtbN0WrzeEECErRHCcMNCOPfXHjMRcJyJrExL4JVM1PF1P...` |
| `vendor\game\js\main.min.js` | 2 | `https://mmocgame.qpic.cn/wechatgame/y95m3WtbN0VOjomhGp4OxUNyXD1xhxccrukicsiau51L9oXZlec...` |
| `vendor\game\js\main.min.js` | 2 | `https://mmocgame.qpic.cn/wechatgame/y95m3WtbN0WZ2oxMX8UibQibTbISbXBibtzBonsgPmyr2aONGri...` |
| `vendor\game\js\main.min.js` | 8 | `http://ali-lxqw-hotfix.ejoy.com/c1_client/debug/dk1_plus/video/test.mp4` |
| `vendor\game\js\main.min.js` | 8 | `https://general.aligames.com/lx_agreement_page/app_permission.html` |
| `vendor\game\js\main.min.js` | 8 | `https://general.aligames.com/lx_agreement_page/sdk_desc.html` |
| `vendor\game\js\main.min.js` | 8 | `https://appeal.lingxigames.com/aq` |
| `vendor\game\js\main.min.js` | 8 | `https://appeal.lingxigames.com/aq` |
| `vendor\game\js\main.min.js` | 8 | `https://www.lingxigames.com/protect` |
| `vendor\game\js\main.min.js` | 20 | `http://ali-x3-srv01.x3.ejoy.com/frog/debug/lingxi/android/game.zip?v=` |
| `vendor\game\js\main.min.js` | 20 | `https://render.aligames.com/p/q/ieu-sdk-h5/anti_addiction_overtime.html?can_close=false...` |
| `vendor\game\js\main.min.js` | 33 | `http://ns.egret.com/eui` |
| `vendor\game\js\main.min.js` | 38 | `http://localhost/Weiduan/game/index.html` |
| `vendor\game\js\main.min.js` | 38 | `http://localhost/Weiduan/game/index.html` |

## 怎么复核

```bash
# 1. 重新生成并阅读本文件
npm run audit:network

# 2. 浏览器侧（最直观）：DevTools → Network 面板，刷新游戏页面。
#    应当只有同源请求，以及一条到 /ws 的 WebSocket；
#    把所有请求按 Domain 排序，不应出现任何外域域名。

# 3. 服务端侧（最严格）：在 NAS 上抓容器的出站流量，
#    确认只有推送目标。
```
