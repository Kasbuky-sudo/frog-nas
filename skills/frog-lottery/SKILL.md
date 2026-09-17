---
name: frog-lottery
description: 在《旅行青蛙》里用抽奖券抽扭蛋——先确认券够 5 张，不够就说明券从哪来，抽到后交代要去游戏里开扭蛋。/ Draw a capsule in the Travelling Frog lottery: confirm at least 5 tickets first, explain where tickets come from when there are not enough, and note that the capsule is opened in the game.
---

# 旅行青蛙 · 抽奖（frog-lottery）

## 何时用
用户说"抽个奖"／"有券了吗"，或查总览时看到 `lottery.canDraw == true`（券已经够了）。

## 连接方式

**只需要一个地址**，默认不需要任何密钥：

```bash
export FROG_API_BASE="http://192.168.1.10:8980"   # 缺失时问用户；其余不用配
```

所有调用都直接发，不需要请求头。只有返回 **401** 时才说明这台服务器特意开了 token
校验（默认关）。那时才向用户要 `FROG_API_TOKEN`，并在请求里加上
`-H "Authorization: Bearer $FROG_API_TOKEN"`。

## 游戏规则
- 一次抽奖消耗 **5 张抽奖券**（原版参数 `RAFFEL_NEEDTICKETS`，接口会在
  `lottery.ticketCost` 里告诉你当前值，**以它为准**，不要写死 5）。
- 抽到的是**颜色扭蛋**（白/绿/蓝/紫/金…按稀有度），**不是直接给东西**。
  真正的奖品要在游戏里把扭蛋打开才拿到（`item_redeem_prize`）。
- 一次只能持有一个未开的扭蛋。已经有未开的扭蛋时，抽奖会返回**已有的那个**
  而不会扣券（引擎的行为）。
- 抽奖次数会累计（`lottery.draws`），有"抽奖 20 次以上"的成就。

## 券从哪来（券不够时这么跟用户解释）
1. **旅行归来**——蛙每次回家都有机会带券；
2. **信箱邮件**——`POST /api/mail/claim` 领取（活动奖励、招待谢礼）；
3. **访客回礼**——招待客人（见 frog-visitor）；
4. **抽奖本身的开场礼物**——第一次打开抽奖界面会送一点三叶草和一件小道具。

## 决策流程

### 1. 看券够不够

```bash
curl -s "$FROG_API_BASE/api/lottery"
```

```json
{ "pendingBall": null, "draws": 0, "ticketCost": 5, "canDraw": false, "phase": 0 }
```

`canDraw` 是权威判断（接口用 `ticketCost` 和当前券数算的）。
`pendingBall != null` 表示**已经有一个没开的扭蛋**，先去游戏里开，别重复抽。

### 2. 券不够就说明来源，别硬抽

```bash
curl -s "$FROG_API_BASE/api/state" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('券',d['resources']['ticket'],'/ 抽奖消耗',d['lottery']['ticketCost'])"
```

差多少就报多少，并告诉用户最快的来源是**领邮件**和**让它出门旅行**：

```bash
curl -s -X POST "$FROG_API_BASE/api/mail/claim" -H "Content-Type: application/json" -d '{}'
```

（领邮件本身就可能直接给券。）

### 3. 抽

```bash
curl -s -X POST "$FROG_API_BASE/api/lottery/draw" -H "Content-Type: application/json" -d '{}'
```

成功：

```json
{ "ok": true, "ball": 3, "rank": 3, "prizeName": "…",
  "ticket": 2, "cost": 5, "pendingBall": 3,
  "message": "已抽到一个扭蛋，在客户端里打开即可领取" }
```

`ball` / `rank` / `pendingBall` 是同一个值：扭蛋的稀有度编号（0 是白球，
**白球也是真奖品**，不是"没抽到"）。编号越大越稀有。

券不够（HTTP 200，`ok:false`）：

```json
{ "ok": false, "ticket": 3, "cost": 5,
  "message": "抽奖券不够（需要 5 张，现有 3 张）…" }
```

这是正常结果，**不要重试**，把 message 讲给用户听。

### 4. 交代后续
抽完必须告诉用户：**扭蛋要回游戏里打开**（庭院/房间界面里的扭蛋机），
接口只负责抽，开奖是客户端的事。想让我再抽，就先把它开掉。

## 错误处理
- `ok:false` + `ticket` 字段 → 券不够，见上。
- `pendingBall != null` 你还去抽 → 返回已有扭蛋、不扣券；这不算失败，但要提醒用户去开。
- `401 / 403` → token 问题（见 frog-status）。

## 汇报给用户的写法
> 用 5 张券抽到了**紫色扭蛋**（还剩 2 张券）。回游戏里把它打开就能拿到奖品，
> 开完想再抽告诉我。
