# 协议文档 / Protocol

两份内容：**游戏自有 wire 协议**（浏览器与 Bot 都用它说话）与
**REST ↔ wire 映射表**（`/api` 每个端点背后发的是哪条指令）。

## 1. Wire 信封

客户端 `core.SocketManage.send()` 序列化出的对象，就是全部约定：

```json
// 客户端 -> 服务端
{ "session": 7, "timestamp": 1789638293, "cmd": "client.load_role", "data": { } }

// 服务端 -> 客户端，回包（session 与请求相同）
{ "session": 7, "data": { } }

// 服务端 -> 客户端，主动推送（没有 session，有 cmd）
{ "cmd": "item.load_items", "data": { } }
```

- `session` 是可选的：带了就是**要回包**的指令（客户端把它登记进
  `activateProtocol[session]`，回包靠它找回回调）。
- `data` 是**按参数名打包的字典**，不是位置参数数组。
- `cmd` 的点号规则：客户端只把**第一个**下划线换成点
  （`client_load_all_info` → `client.load_all_info`）。服务端的
  `canon()`/`toWire()` 双向兼容两种写法。

## 2. 握手时序

浏览器 `NetworkControl.totalEvents` 的实际路径（本构建 `channelType = 1`，
即 `ChannelType.Test`）：

```
WS 连接建立
  → 发 hall_gen_token {account:<用户名>}
  ← 收 {code:0, token:'offline-<account>'}
  → 发 hall_login {token}
  ← 收 {code:0, account}
  → 发 hall_enter_game {}
  ← 收 {code:0}，并紧接着收到 42 条状态推送
```

那 42 条推送是 `BOOT_PUSH` 列表（`client.load_role`、`weather.load`、
`clover.load_clovers`、`item.load_items`、`mail.load`、`album.load`、`guest.load` …
共 42 条）。**客户端一条都不会主动请求**——它们全部注册在
`addProtocolCallback` 里，所以服务端漏发任何一条都会让对应模型空着，
甚至卡住场景启动。

Bot 客户端（`src/bot.js`）复刻的正是这三步；握手在服务启动时做一次，
之后按需 `dispatch`，因为**引擎没有连接级状态**——它是单一共享世界。

## 3. 收消息入口与推送机制（宿主实现依据）

```js
engine.dispatch(cmd, data)  // -> { reply?, handled, pushes: [{cmd, data}] }
engine.tick()               // -> [ {cmd, data} ]
```

- handler 用闭包里的 `ctx.push(name, data)` 投递主动消息；
  `dispatch` 与 `tick` 各自造一个 `ctx`，所以推送要么随回包返回、要么从 tick 返回。
- `handled:false` 表示这条指令没有 handler（`src/engine-host.js` 会把它记进
  `unknownReport`）。本项目对 243 条协议实测覆盖 **217 条**；未覆盖的 26 条见 §6。
- 回包只有在该协议的 `needResponse` 为真时才存在。**这一点有实际影响**：
  `guest_serve` 的 `needResponse` 是 `false`，成功和失败都返回 `undefined`，
  只能靠 `state.guest.served` 判断结果（`/api/visitor/feed` 就是这么做的）。

## 4. 状态投影：`/api/state` 的字段来源

| 字段 | 来源 | 备注 |
|---|---|---|
| `frog.status` | `state.frog.status` | 0 在家 / 1 外出 / 2 待机 / 3 聚会 |
| `frog.motion` | `state.frog.motion` | 在家时的动作序号 |
| `frog.away` / `returnInSec` / `nextDepartAt` | `state.travel.*` | 由服务端时间戳算出 |
| `frog.waitingForBag` | `state.travel.waitingForBag` | **true = 在家但没备行李，所以不出门** |
| `resources.clover` / `ticket` | `state.clover` / `state.ticket` | 权威值，直接读 |
| `clovers.slots[].status` | 引擎的 `cloverStatus()` | `last_harvest === -1` → empty；`last_harvest + rebirth_span > now` → growing；否则 ready |
| `clovers.readySlots` | 同上 | 直接传给 `POST /api/harvest` |
| `storage.bag` / `desk` / `house` | `state.items.*` | 空格子的哨兵值是 **`-1`** |
| `mail.*` | `state.mails` | `unread` 统计 `opened === false` |
| `guest.*` | `state.guest` | 含 `favourites`（`Character.taste` 查表） |
| `lottery.ticketCost` | `define.json` 的 `RAFFEL_NEEDTICKETS` | 别写死 5 |
| `collections.progress` | 表总数 vs 已拥有 | `Picture` 351 / `Specialty` 64 / `Collection` 62 |
| `owned.feedableSpecialtys` | `state.items.house` + bag + desk | **能喂的**，与图鉴不同 |

### 为什么 `/api/state` 不暴露目的地

旅行计划在**出发时**决定（`provisionTrip()` 写入 `state.travel.plan`），
玩家要等明信片寄回来才知道蛙去了哪儿。接口跟着这个设计走，不把 `plan` 暴露出去，
所以调用方不能承诺"它去了北京"。这条约束由
`test/unit/skills-consistency.test.js` 里的一个测试守着（frog-status 必须写明这点）。

### 「特产」的两个不同的桶（踩过的坑）

| 桶 | 位置 | 谁写 | 谁读 |
|---|---|---|---|
| **图鉴** | `state.specialtys` + `handbook.specialtys` | 旅行归来时记录 | 图鉴页、`/api/collections` |
| **家里的实物** | `state.items.house` | 旅行归来时**不进这里** | `getHaveItem()`、投喂、制作 |

旅行带回来的特产只进**图鉴**；客户端投喂前执行的是
`ItemModel.consumeHouseItem(itemId, 1)`（从**家里**扣一件），
访客面板打开的也是 `PlayerBag(ParentType.Neighbor)`。
所以"图鉴里有"≠"现在能喂"。`/api/state` 用 `owned.feedableSpecialtys`
把两者分开报，`/api/visitor/feed` 也会明确拒绝图鉴里才有的东西。

### 物品 id 0 是真实物品

`0` 是**奶油华夫饼**（type 0）。空格子的哨兵是 `-1`，不是 `0`。
任何"`id > 0` 才算有东西"的写法都会把装了 0 号物品的格子误判为空——
本项目所有格子判断都走 `state-view.js` 的 `isEmptySlot()`，并且
`test/integration/game-loop.test.js` 有一个专门的用例守着。

## 5. REST ↔ wire 指令映射

`/api` 的每个动作都由进程内 bot 客户端转成一条原版指令，因此规则完全一致。

| REST | wire 指令 | 参数 | 备注 |
|---|---|---|---|
| `GET /api/state` | `client_load_role` `weather_load` `clover_load_clovers` `item_load_items` `item_load_shop_info` `item_load_handbook` `mail_load` `guest_load` `album_load_all` `lottery_load` `task_load` | — | 按需读取多条 `*_load` 并投影 |
| `POST /api/harvest` | `clover_harvest` | `{clover_id}` | 每格一条；`code 0` 成功、`1` 格号无效、`2` 未成熟 |
| `GET /api/luggage` | `item_load_items` | — | 返回 `state.items.bag` |
| `PUT /api/luggage` | `item_takeout_bag` + `item_putin_bag` | `{pos, item_id}` | 先清格子再放；**类型校验在 API 层**（见下） |
| `GET /api/table` | `item_load_items` | — | `state.items.desk` |
| `PUT /api/table` | `item_takeout_desk` + `item_putin_desk` | `{pos, item_id}` | 同上 |
| `DELETE /api/table` | `item_takeout_desk` × 8 | `{pos}` | 逐格清 |
| `GET /api/shop` | `item_load_shop_info` | — | 与 `gamedata.shopData`（66 行）合并 |
| `POST /api/shop/buy` | `item_buy` | `{shop_id}` | **参数是货架号不是物品 id**；`itemId` 由 API 换算 |
| `POST /api/visitor/feed` | `guest_serve` | `{id, item_id}` | 无回包，靠 `served` 判定（见 §3） |
| `POST /api/lottery/draw` | `item_gacha` | `{is_reward:false}` | 消耗 `RAFFEL_NEEDTICKETS` 张券 |
| `GET /api/mail` | `mail_load` | — | |
| `POST /api/mail/claim` | `mail_open` | `{id}` | 逐封领取 |
| `GET /api/collections` | `album_load_all` `item_load_handbook` `museum_load` | — | |
| `POST /api/debug/gm` | `client_gm` | `{cmd}` | **默认关闭**，需 `FROG_ENABLE_GM_API=1` |

### 为什么 API 层自己做了格子类型校验

引擎的 `item_putin_bag` / `item_putin_desk` 是**不做类型检查**的，
它们只写格子并返回 `{code:0, conflict:0}`——因为游戏里是 UI 在挡
（玩家没法把水壶拖进便当格）。API 没有 UI，所以这一层用引擎自己的槽位表
（`BAG_SLOT_TYPE = [便当, 护身符, 工具, 工具]`、
`DESK_SLOT_TYPE = [便当, 便当, 护身符, 护身符, 工具×4]`）补上校验。
放错格不会破坏结算（`provisionTrip` 是按类型扫描的），但会**画错**，
正是引擎注释里 `placeBack` 要避免的那类问题。

## 6. 协议覆盖情况

243 条协议中，引擎实现了 217 条。**未实现的 26 条**：

```
client_taobao_import  client_draw_taobao  client_set_wx_open_id
client_get_push_reward  client_get_my_wx_reward  client_share_publicity
clover_update  hall_hello  hall_report_remote_addr  item_update
item_update_ticket  rank_like  task_client_pro
capsule_load_coin  capsule_load_task  animpicture_add_pic  other_req_touch
koto_load  koto_refresh  koto_random_compass  koto_dir_compass
koto_get_items  koto_arrive  koto_start_advance  koto_load_path  koto_info
```

分三类，都不是缺陷：

1. **纯推送类**（`clover_update`、`item_update`、`item_update_ticket`）——
   客户端只注册回调、从不发送，服务端只推。
2. **渠道/活动类**（`koto_*` 是另一个已关闭的活动、`*_taobao_*`、`*_wx_*`、
   `rank_*` 需要真实服务端排行榜）。
3. **`hall_report_remote_addr`** 之类只做记录的空指令。

引擎内部有一张"协议定义 vs handler 覆盖"的清单，`src/engine-host.js` 的
`unknownReport()` 可随时查实际遇到的未知指令。

## 7. 推送事件

事件由**状态差分**产生（`src/push/events.js`），不依赖引擎是否主动推了消息。
快照每 tick 取一次，字段：蛙状态、邮件 id 集合、访客 id/是否已招待、
照片 id 集合（含 `albumPending`/`giftBox`）、特产数、券/三叶草、成就、制作完成时间。

| 事件 | 触发条件 | 载荷 |
|---|---|---|
| `depart` | `frog.status` 非 1 → 1 | `{departAt, tripCount}` |
| `return` | 1 → 非 1 | `{newPictureIds, cloverDelta, ticketDelta, tripCount, pendingPictures}` |
| `postcard` | 照片 id 集合新增（含只进了 `albumPending` 的） | `{picId, name}` |
| `mail` | `state.mails` 出现新 id | `{mailId, mailType, title, message, clover, ticket, items, pictures, postcard}` |
| `visitor_arrive` | 访客 null → 非 null | `{visitorId, name}` |
| `visitor_gift` | 同一访客 `served` false → true | `{visitorId, ticketDelta}` |
| `lottery` | 券数跨过 `ticketCost` | `{ticket, cost}` |
| `title_unlock` | 成就数增加且称号变化 | `{achieveId, name}` |
| `furniture_finish` | 制作 `finishAt` 从有到无 | `{furnitureId}` |

**明信片为什么单列一个事件**：一趟旅行带回来的照片先落在
`state.albumPending`（客户端的「新照片」列表），要玩家在游戏里归档才进
`state.pictures`。只盯 `pictures` 会完全错过"照片到了"这个瞬间。

### Webhook 模板占位符

| 占位符 | 值 |
|---|---|
| `{{event}}` | 事件名（上表左列） |
| `{{title}}` | 中文标题，如「青蛙出发了」 |
| `{{body}}` | 中文正文，已带摘要（回礼张数、三叶草增量等） |
| `{{timestamp}}` | ISO 8601 |
| `{{url}}` | `PUBLIC_URL`（或设置页填的对外地址） |
| `{{image}}` | 明信片图片绝对地址（有 `picId` 时） |
| `{{data}}` | **原始数据对象**；单独占一个值时是嵌套 JSON，写在引号里则转义成字符串 |
| `{{dataJson}}` | 始终是字符串化的 JSON |

默认模板产出：

```json
{
  "event": "depart",
  "title": "青蛙出发了",
  "body": "蛙背上行囊出门了，去哪儿还不知道——等它的明信片吧。",
  "timestamp": "2026-09-17T10:00:27.000Z",
  "url": "http://nas:8980/",
  "image": "",
  "data": { "departAt": 1789639228, "tripCount": 1 }
}
```

模板不是合法 JSON 时（例如 `{{title}}: {{body}}`）以 `text/plain` 发送。

### MeoW

按官方文档实现：**昵称即收件人**，无 token。

```
POST {base}/{昵称}          Content-Type: application/json
{"title": "...", "msg": "...", "url"?: "...", "imgUrl"?: "..."}

GET  {base}/{昵称}/{title}/{msg}?url=&imgUrl=&msgType=text|html&htmlHeight=200
```

成功判据是**响应体里 `status === 200`**，不是 HTTP 状态码——
服务端用 200 包着业务错误（昵称不存在时就是 `{"status":400,...}`）。
本项目 `POST` 优先（JSON body，标题里的 `/`、`?` 不用转义），
`GET` 保留给只接受 GET 的部署。见 `src/push/meow.js`。

## 8. 免打扰与重试

- 免打扰（默认 23:00–07:00，可关）：窗口内的事件**排队不丢**，窗口结束后补发。
  跨午夜的窗口（from > to）按"或"判断。
- 重试：默认 3 次，退避 2s → 4s → 8s。每个通道独立重试。
- 所有尝试（成功/失败/排队/重试）都写 `data/logs/push.jsonl`，一条一个 JSON 行。
