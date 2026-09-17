---
name: frog-status
description: 查看《旅行青蛙》当前世界的总览（蛙在哪、三叶草、背包桌子、邮件、访客、抽奖券、图鉴进度）。做任何其他操作前都先用它判断状态。/ Read the current state of the Travelling Frog world (where the frog is, clovers, bag and desk, mail, visitor, tickets, collection progress). Use it first, before every other frog action.
---

# 旅行青蛙 · 查总览（frog-status）

## 何时用
**每次操作前都先调它。** 这个接口是其他四个技能的前置判断：收草要知道草熟没熟、
备行李要知道库存和蛙在不在家、访客要知道有没有客人、抽奖要知道券够不够。
空手做别的事只会拿到"游戏拒绝了"的回复。

## 连接方式

**只需要一个地址**，默认不需要任何密钥：

| 变量 | 含义 | 例子 |
|---|---|---|
| `FROG_API_BASE` | 服务地址，结尾不带斜杠。**缺失时问用户** | `http://192.168.1.10:8980` |

```bash
export FROG_API_BASE="http://192.168.1.10:8980"   # 只改这一行
curl -s "$FROG_API_BASE/api/health"
# {"ok":true,"engine":true,"uptimeSec":123,"clients":1,"bot":{...},"now":1789638293}
```

就这些。所有 `/api` 端点都直接用，不用加任何请求头：

```bash
curl -s "$FROG_API_BASE/api/state"
```

`engine` 为 `false` 说明服务端引擎没起来，此时所有操作都会失败，先让用户看容器日志。

**如果返回 401**，说明这台服务器的拥有者**特意打开了** token 校验（默认是关的）。
这时才需要 `FROG_API_TOKEN`，值是 `/admin` 页面上的「API Token」：

```bash
export FROG_API_TOKEN="…"    # 用户给你才需要
curl -s "$FROG_API_BASE/api/state" -H "Authorization: Bearer $FROG_API_TOKEN"
```

遇到 401 **先问用户要 token**，不要反复重试，也不要以为地址写错了。

## 查总览

```bash
curl -s "$FROG_API_BASE/api/state"
```

## 响应字段

```
{
  "server":  { "now": 1789638293, "timeZone": "Asia/Shanghai" },
  "frog": {
    "name": "呱呱",
    "status": "home",          // home 在家 / away 外出 / standby 待机 / party 聚会
    "statusCode": 0,           // 引擎原始值
    "motion": 4,               // 在家时的动作序号
    "away": false,
    "departAt": 0,             // 本次出发时间戳
    "returnAt": 0,             // 预计回家时间戳（外出时有效）
    "returnInSec": null,       // 还有多少秒回来
    "nextDepartAt": 1789638360,// 下次可能出发的时间
    "tripCount": 0,            // 累计出行次数
    "waitingForBag": false,    // true＝在家但没备行李，所以不出门
    "prepared": false          // 是否已备好（背包或桌子有东西）
  },
  "resources": { "clover": 10019, "ticket": 3 },
  "clovers": {
    "total": 20,
    "readyCount": 20,
    "readySlots": [1,2,3,...],  // 可以收的格号，直接传给收草接口
    "fourLeafReady": [],        // 熟了而且是四叶草的格号
    "nextReadyAt": 1789645881,  // 最近一株什么时候熟
    "full": true,               // 整片长满了（没有还在长的、且有可收的）
    "growingCount": 0,          // 还在长的格数
    "emptyCount": 0,            // 空（没种）的格数
    "fullAt": null,             // 最后一株什么时候熟 = 什么时候长满（≠ nextReadyAt）
    "slots": [ { "slot":1, "status":"ready", "fourLeaf":false, "readyAt":null } ]
  },
  "storage": {
    "bag":  [ { "slot":1, "itemId":-1, "empty":true } ],
    "desk": [ { "slot":1, "itemId":-1, "empty":true } ],
    "house":[ { "itemId":0, "count":3, "name":"奶油华夫饼", "type":0 } ]
  },
  "mail": {
    "total": 2, "unread": 2,
    "recent": [ { "id":1, "title":"…", "opened":false, "clover":500, "ticket":0, "items":[], "pictures":0 } ]
  },
  "guest": null,               // 有人来时是 { id, name, served, expireAt, favourites:[…] }
  "lottery": { "pendingBall":null, "draws":0, "ticketCost":5, "canDraw":false, "phase":0 },
  "collections": {
    "progress": {
      "pictures": { "owned":15, "total":351 },
      "specialtys": { "owned":0, "total":64 },
      "collections": { "owned":20, "total":62 }
    }
  },
  "specialtys": []
}
```

**注意：`frog` 里没有目的地。** 游戏里蛙去哪儿要等明信片寄回来才知道，接口故意不给，
所以不要向用户承诺"它去了哪里"。

## 决策流程
1. `GET /api/health`，`engine` 必须是 `true`。
2. `GET /api/state`，然后按需求分流：
   - `clovers.readyCount > 0` → 用 `frog-harvest` 收草。**注意 `readyCount > 0` 不等于
     "长满了"**：20 格各自独立重生（平均 2 小时一株），所以经常是"熟了两三株、其余还在长"。
     只有 `clovers.full == true` 才是整片长完——推送通知也是按 `full` 发的，别用
     `readyCount` 去解释那条通知。只熟了一部分时，报 `fullAt`（预计什么时候长满）
     比催用户现在去收更有用。
   - `frog.waitingForBag == true` → 用 `frog-prepare` 备行李（这是蛙不出门的原因）。
   - `guest != null && guest.served == false` → 用 `frog-visitor` 招待。
   - `lottery.canDraw == true` → 用 `frog-lottery` 抽奖。
   - `mail.unread > 0` → 领邮件（`POST /api/mail/claim`）。
3. 把结果讲给用户听时用中文，并把"蛙现在在做什么"说清楚（在家／出门了／等行李）。

## 后台一直在跑（可以放心告诉用户）

服务端引擎**不依赖浏览器**：关掉网页、关掉电脑，青蛙照样按时间出门、回家、带东西，
院子里的草照样长。所以：

- 用户问「我关了网页它还会走吗」→ **会**，世界在服务器上跑。
- 用户问「它什么时候回来」→ 看 `frog.returnInSec`（外出时是还差多少秒）。
- 想让用户被主动通知（不用自己盯着问），见下面的「推送」。

## 推送（用户可订阅的通知）

游戏会在这些时刻主动推送到用户的手机/手表（在 `/admin` 里配置通道与订阅）：

| 事件 | 什么时候 |
|---|---|
| `depart` | 青蛙出发 |
| `return` | 青蛙回家（**会说明带了什么**：几张照片、哪些特产、三叶草/券增量） |
| `postcard` | 收到新明信片 |
| `clover_ready` | 院子里的三叶草**全部**长好了才发（20 格各自独立重生，等最后一格长完；见 `src/push/events.js`）。**纯靠时间触发**，没有别的事也会响 |
| `visitor_arrive` / `visitor_gift` | 有访客来 / 招待后的回礼 |
| `mail` / `lottery` / `title_unlock` / `furniture_finish` | 新邮件 / 券够了 / 新称号 / 家具做好 |

想确认推送有没有在发，可以查：

```bash
curl -s "$FROG_API_BASE/api/logs/push?limit=20"
```

返回最近 20 条发送记录（含成功/失败与原因）。**用户说"我没收到通知"时先看这个**，
再让他检查 `/admin` 里的通道是否启用、昵称/地址是否填对。

## 常见错误
| HTTP | code | 含义与处理 |
|---|---|---|
| 401 | `unauthorized` | 这台服务器**特意要求 token**（默认不要求）。**先问用户要 token**，拿到后加 `-H "Authorization: Bearer $FROG_API_TOKEN"`。 |
| 403 | `forbidden` | token 不对。让用户在 `/admin` 里核对或重置，不要重试。 |
| 连不上 | — | 服务没起或地址错。确认 `FROG_API_BASE` 和容器状态。 |

## 汇报给用户的写法
> 蛙现在**在家**，正在看书。院子里 20 株三叶草都熟了（可以收），抽奖券 3 张
> （够 5 张就能抽），信箱有 2 封没拆。目前没有客人来。
