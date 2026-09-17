---
name: frog-visitor
description: 发现《旅行青蛙》院子里来的访客，按它的口味投喂最合适的特产，并追踪回礼。/ Notice a visitor in the Travelling Frog garden, feed it the local specialty it likes best, and follow up on the gift it leaves.
---

# 旅行青蛙 · 招待访客（frog-visitor）

## 何时用
用户说"有客人吗"／"喂一下客人"，或查总览时看到 `guest != null && guest.served == false`。
也可以在有访客时**主动提醒用户**（推送事件 `visitor_arrive` 就是干这个的）。

## 连接方式

**只需要一个地址**，默认不需要任何密钥：

```bash
export FROG_API_BASE="http://192.168.1.10:8980"   # 缺失时问用户；其余不用配
```

所有调用都直接发，不需要请求头。只有返回 **401** 时才说明这台服务器特意开了 token
校验（默认关）。那时才向用户要 `FROG_API_TOKEN`，并在请求里加上
`-H "Authorization: Bearer $FROG_API_TOKEN"`。

## 游戏规则（先读懂再动手）
- 房间/院子里的访客是「邻居」：**一次到访只能投喂一次**，喂完它就走了，还会留下**回礼**。
- 投喂用的必须是**特产**（type 3，旅行带回来的土产），不能是便当。
- **投喂消耗的是「家里」的库存**，不是特产图鉴。客户端喂食前会先执行
  `consumeHouseItem`（从家里扣掉一件），所以只看图鉴列表会误判——
  图鉴里有≠现在能喂。`/api/state` 的 `owned.feedableSpecialtys` 就是"现在真能喂的"。
- 每种特产对每位访客都有一个**口味值**（游戏自己的 `Character.taste` 表）。
  客户端把它翻译成四种反应：
  | 口味值 | 反应 |
  |---|---|
  | ≥ 80 | 非常喜欢（回礼最好） |
  | ≥ 60 | 喜欢 |
  | ≥ 20 | 一般 |
  | < 20 | 不太喜欢 |
- 所以**挑它最爱的特产喂**收益最高。接口已经帮你把偏好排好序了。

## 决策流程

### 1. 看有没有访客、它喜欢什么

```bash
curl -s "$FROG_API_BASE/api/state" \
  | python3 -c "import sys,json;g=json.load(sys.stdin)['guest'];print(json.dumps(g,ensure_ascii=False,indent=1) if g else '现在没有访客')"
```

`guest` 字段：

```json
{
  "id": 2,
  "name": "胖胖",
  "served": false,          // true = 已经喂过了，别再喂
  "confirmed": false,
  "expireAt": 1789639710,   // 它什么时候走
  "favourites": [           // 按口味值从高到低，已经算好
    { "itemId": 3001, "taste": 99, "name": "豆腐乳", "owned": true }
  ]
}
```

`guest == null` 就是没客人：告诉用户，然后**别硬喂**。

### 2. 挑一件你**现在真有**的特产

`favourites[].owned` 就是"家里/背包/桌子上有"，直接信它。
也可以自己看 `owned.feedableSpecialtys`：

```bash
curl -s "$FROG_API_BASE/api/state" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin); g=d['guest']
if not g: print('没有访客'); raise SystemExit
have={s['itemId'] for s in d['owned']['feedableSpecialtys']}
best=[f for f in g['favourites'] if f['itemId'] in have]
print('推荐投喂:', best[0] if best else '现在没有能喂的特产', '| 可喂:', [s['name'] for s in d['owned']['feedableSpecialtys']])
"
```

**注意区分两个列表**：
- `owned.feedableSpecialtys` —— 现在真能喂的（家里/背包/桌子上的）。
- `specialtys` —— 特产**图鉴**（收集记录），里面的东西**不一定**还在家里。

图鉴里有、但家里没有时，接口会明确告诉你：
`家里没有这件特产（它在特产图鉴里，但投喂消耗的是家里的库存，请先在游戏里把它放进家里）`。
这种情况要如实转告用户，**不要反复重试**。旅行带回来的特产会先进家里，
所以通常直接喂就好。

### 3. 投喂

知道该喂什么：

```bash
curl -s -X POST "$FROG_API_BASE/api/visitor/feed" -H "Content-Type: application/json" \
  -d '{"visitorId":2,"itemId":3001}'
```

懒得挑，让接口自己选它最爱且你手上有的（推荐）：

```bash
curl -s -X POST "$FROG_API_BASE/api/visitor/feed" -H "Content-Type: application/json" \
  -d '{"auto":true}'
```

`auto` 会从 `favourites` 里挑第一件你家里真有的；一件都没有时返回 409 并说明原因。

### 4. 读结果

```json
{
  "ok": true,
  "visitorId": 2,
  "itemId": 3001,
  "name": "豆腐乳",
  "taste": 99,
  "reaction": "delighted",      // delighted / pleased / indifferent / put_off
  "ticketDelta": 2,             // 这次回礼给的抽奖券
  "guest": { "id": 2, "served": true, ... }
}
```

`taste` 和 `reaction` 是**投喂后**的真实评价，直接拿来汇报。
`ticketDelta` 是回礼里的抽奖券增量（回礼也可能给三叶草或道具，
可以对比投喂前后 `/api/state` 的 `resources.clover`）。

### 5. 追踪回礼
回礼当场结算（`ticketDelta` / 三叶草变化 / 邮件）。如果用户想确认所有收益，
投喂后再查一次 `/api/state`，对比 `resources` 与 `mail.unread`。

## 错误处理
| HTTP | 情况 | 处理 |
|---|---|---|
| 409 | `现在没有访客` | 正常情况，告诉用户等下一次（`visitor_arrive` 推送会通知）。 |
| 409 | `这位访客已经招待过了` | 别重试。同一次到访只有一次机会。 |
| 409 | `访客已经换了` | 重新查 `/api/state` 拿当前 `guest.id` 再来一次。 |
| 409 | `家里没有这件特产` | 该特产只在图鉴里，家里没有实物。让用户先在游戏里把它放进家里，或换一件 `owned.feedableSpecialtys` 里的。 |
| 409 | `这件不是特产` | 传的是便当/工具。换一件 type 3 的特产。 |
| 409 | `投喂被拒绝` | 引擎静默拒绝（通常是没有实物或已招待过）。改用 `auto:true` 或重查 `/api/state`。 |

## 汇报给用户的写法
> 院子里来了**胖胖**，我拿「豆腐乳」招待了它——它**非常喜欢**，留下 2 张抽奖券。
> 现在它已经走了，下次来我再叫你。
