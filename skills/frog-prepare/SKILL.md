---
name: frog-prepare
description: 给《旅行青蛙》备好出门行李——查库存、缺便当就去商店买、按意图把东西放进背包、可选放到桌子上，并说明出发时间由蛙自己随机决定。/ Prepare the Travelling Frog's luggage: check stock, buy a lunch box if none, pack the bag for the intent, optionally set the desk, and explain that departure time is decided by the frog at random.
---

# 旅行青蛙 · 备行李（frog-prepare）

## 何时用
用户说"让它出去玩"／"给它准备点东西"／"备行李"，或者查总览时看到
`frog.waitingForBag == true`（**在家但不出门，就是因为没东西可带**）。

## 连接方式

**只需要一个地址**，默认不需要任何密钥：

```bash
export FROG_API_BASE="http://192.168.1.10:8980"   # 缺失时问用户；其余不用配
```

所有调用都直接发，不需要请求头。只有返回 **401** 时才说明这台服务器特意开了 token
校验（默认关）。那时才向用户要 `FROG_API_TOKEN`，并在请求里加上
`-H "Authorization: Bearer $FROG_API_TOKEN"`。

## 背包和桌子的规则（重要）

**背包 4 格，每格只放特定类型**（引擎的 `BAG_SLOT_TYPE`）：

| 格号 | 放什么 | 物品 id 段 |
|---|---|---|
| 1 | 便当 | 0–999（type 0） |
| 2 | 护身符 | 1000–1999（type 1） |
| 3 | 工具 | 2000–2999（type 2） |
| 4 | 工具 | 同上 |

**桌子 8 格**：1–2 便当、3–4 护身符、5–8 工具。

放错格会被接口拒绝（`ops[].reason` 会说明），因为客户端是按格号画图的。
桌子上的东西蛙出门时会**自己挑**带走：没带护身符就拿桌上的，工具不够 2 件就补。

**没有便当就会"放浪"**：不保证带特产和照片回来，而且回家更快（原版
`FROG_DRIFTRETURNTIME` 10–20 分钟）。所以**永远先确认有便当**。

## 决策流程

### 1. 先看现状

```bash
curl -s "$FROG_API_BASE/api/state"
```

需要看：`storage.house`（库存）、`storage.bag` / `storage.desk`（是否已装）、
`frog.status`（在家才能备）、`frog.waitingForBag`。

**"有东西"看 `storage.house`，不是 `specialtys`。** `specialtys` 是特产**图鉴**
（收集记录），`storage.house` 才是家里实际能带走的东西。两者可能不一致。<br>
另外 **0 号物品（奶油华夫饼）是真实物品**：判断格子空不空看 `empty` 字段，
不要用 `itemId > 0` 去猜。

### 2. 从家里挑东西

`storage.house` 里每项是 `{itemId, count, name, type}`。按类型挑：

- **便当**（type 0）放 1 号格；优先挑 `H_MAXTIME` 效果好的（原版旅行时长按便当 HP 放大，
  例如茄汁蛋包饭约 1.7 倍）。名字里带"饭""饼""面包"的基本都是便当。
- **护身符**（type 1）放 2 号格，影响旅途事件。
- **工具**（type 2，如水壶/纸伞/睡垫）放 3、4 号格。工具决定能走哪种地形
  （洞穴/海/山），想让它去特定类型的景点可以据此选。

库存按 id 计数，放了之后家里的数量会减少（`PUT /api/luggage` 只是把 id 写进格子；
**物品是消费还是带回由引擎结算**：消耗品（`spend === 1`，多数便当）出门就吃掉，
耐用品会跟着回家放回原来的格子）。

### 3. 缺便当就买

```bash
curl -s "$FROG_API_BASE/api/shop" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print([ (i['shopId'],i['name'],i['price']) for i in d['items'] if i['type']==0 and i['available'] and i['affordable']][:5])"
```

```bash
curl -s -X POST "$FROG_API_BASE/api/shop/buy" -H "Content-Type: application/json" \
  -d '{"shopId":0,"qty":1}'
```

`shopId` 是**货架号**（不是物品 id）。也可以传 `itemId`，接口会自己换算。
买到的便当进 `storage.house`，然后才能放进背包。

### 4. 装背包

```bash
curl -s -X PUT "$FROG_API_BASE/api/luggage" -H "Content-Type: application/json" \
  -d '{"slots":{"1":0,"2":1001,"3":2000,"4":2001}}'
```

`slots` 的键是**格号**，值是**物品 id**；值为 `-1` 表示清空该格。
也可以按顺序传 `{"items":[0,1001,2000,2001]}`。

响应里 `ops[]` 逐格给结果，`failed` 是失败格数：

```json
{ "ok": true, "failed": 0,
  "ops": [ {"op":"takeout","pos":1,"ok":true}, {"op":"putin","pos":1,"itemId":0,"name":"奶油华夫饼","ok":true} ],
  "bag": [ {"slot":1,"itemId":0,"name":"奶油华夫饼"...} ] }
```

### 5. 可选：桌子上也放一份

桌子上放便当/护身符/工具，蛙出门时会自己补带（背包没带护身符就拿桌上的）。

```bash
curl -s -X PUT "$FROG_API_BASE/api/table" -H "Content-Type: application/json" \
  -d '{"slots":{"1":1,"3":1002}}'
```

清空桌子：

```bash
curl -s -X DELETE "$FROG_API_BASE/api/table"
```

### 6. 汇报（务必说明出发时间不可控）

备好之后再查一次 `GET /api/state` 确认 `frog.prepared == true`，然后告诉用户：
东西已经放好了，**但什么时候出发是蛙自己掷骰子决定的**，`nextDepartAt` 是它
下一次可能出门的时间。想立刻看到它出门，只能在游戏页面里手动操作，
或者用 `/admin` 的存档编辑器（`travel_now`）——那是管理员操作，不要自己悄悄做。

## 响应/错误
- 类型不符：`ops[].reason` 会写「N 号格是「便当」位，放不了「水壶」」，换对格子再放。
- 家里没有这样东西：接口不会报错，但 `GET /api/state` 的 `storage.house` 里找不到，
  此时要么买、要么换一件。
- `401/403`：token 问题（见 frog-status）。

## 汇报给用户的写法
> 已经给它备好了：便当「奶油华夫饼」、护身符「绿色铃铛」、两件工具（竹筒、葫芦），
> 桌上又放了一份草莓可丽饼。**出发时间是它自己定的**（随机 2–6 分钟后再掷一次），
> 出门后我会用推送通知你。
