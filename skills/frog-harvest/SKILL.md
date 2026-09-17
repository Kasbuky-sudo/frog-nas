---
name: frog-harvest
description: 收割《旅行青蛙》庭院里已经长好的三叶草，并交代四叶草会变成道具而不是三叶草。先查总览确认有熟的。/ Harvest the ripe clovers in the Travelling Frog garden, noting that a four-leaf clover becomes an item rather than currency. Check the status first.
---

# 旅行青蛙 · 收三叶草（frog-harvest）

## 何时用
用户说"收一下草"／"收三叶草"，或者你查完总览发现 `clovers.readyCount > 0` 顺手收掉。
**别对着没熟的草反复调用**：那只会拿到 `code:2`（还没长好）。

## 连接方式

**只需要一个地址**，默认不需要任何密钥：

```bash
export FROG_API_BASE="http://192.168.1.10:8980"   # 缺失时问用户；其余不用配
```

所有调用都直接发，不需要请求头。只有返回 **401** 时才说明这台服务器特意开了 token
校验（默认关）。那时才向用户要 `FROG_API_TOKEN`，并在请求里加上
`-H "Authorization: Bearer $FROG_API_TOKEN"`。

## 先查有没有熟的

```bash
curl -s "$FROG_API_BASE/api/state" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); c=d['clovers']; print('ready',c['readyCount'],'of',c['total'],c['readySlots'])"
```

`readyCount == 0` 就**不要收**，告诉用户还要等多久：`nextReadyAt` 是最近一株成熟的时间戳。

## 收草（全部）

```bash
curl -s -X POST "$FROG_API_BASE/api/harvest" \
  -H "Content-Type: application/json" \
  -d '{}'
```

不传参数就是"把所有已长好的都收掉"，这是最常用的调用。

## 收草（指定格号）

```bash
curl -s -X POST "$FROG_API_BASE/api/harvest" \
  -H "Content-Type: application/json" \
  -d '{"slots":[1,2,3]}'
```

单株也可以：`-d '{"slot":1}'`。

## 响应字段

```
{
  "ok": true,             // 至少收到一株
  "harvested": 20,        // 实际收到的株数
  "requested": 20,        // 请求的株数
  "fourLeaf": 0,          // 其中四叶草几株
  "clover": 10019,        // 收完后的三叶草总数（权威值，直接读它）
  "cloverGained": 20,     // 本次三叶草的净增量
  "results": [
    { "slot": 1, "ok": true, "code": 0 },
    { "slot": 2, "ok": false, "code": 2, "reason": "这株三叶草还没长好" }
  ],
  "message": "没有可收的三叶草"   // 全部失败时出现
}
```

**要害：四叶草不是三叶草。** 游戏里四叶草（`fourLeaf: true` 的那株，或
`results[].granted == "four_leaf"`）收下来会变成**背包里的道具**
（`Define.FourLeafCloverID`），不进三叶草总数。所以
`cloverGained` 可能小于 `harvested`，这是对的，不要当成 bug。

播种是自动的，收完的格子会自己重新长（`slots[].readyAt` 告诉你什么时候熟）。

## 决策流程
1. `GET /api/state` → 看 `clovers.readySlots`。
2. 有就 `POST /api/harvest {}`。
3. 读回 `harvested` / `fourLeaf` / `clover`，把增量讲给用户。
4. 如果用户目标是"攒够买某样东西"，顺手报一下离目标还差多少（对比 `GET /api/shop` 的价格）。

## 常见错误
- `{"ok":false,"harvested":0,...}` 200 响应 → 草没熟或格号无效，**不是接口错误**。
  看 `results[].code`：`1` = 格号不存在，`2` = 还没长好。
- 401 / 403 → token 问题，问用户（见 frog-status）。

## 汇报给用户的写法
> 收了 20 株三叶草，其中 1 株是四叶草（变成道具放家里了）。三叶草现在 **10019**。
