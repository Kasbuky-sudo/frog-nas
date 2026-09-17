# 手工 / 诊断脚本

这些脚本**不参与 `npm test`**（自动化测试在 `test/unit/` 与 `test/integration/`）。
它们需要一个正在运行的服务器，或者用来单独诊断某一层，所以留着但手动运行。

先起服务：

```bash
npm start          # 监听 8980
```

然后按需运行：

| 脚本 | 用途 | 运行方式 |
|---|---|---|
| `acceptance.js` | §6 验收清单的自查：版权弹层、Route A、CSP、认证、5 个技能、vendor 无安卓壳等 31 项 | `node test/manual/acceptance.js` |
| `api-flow.js` | 逐个走一遍 `/api` 端点（收草→购买→装包→桌子→邮件→图鉴→抽奖），每步断言 | `node test/manual/api-flow.js` |
| `http-smoke.js` | HTTP 层冒烟：index 注入、gameConfig 改写、X-Forwarded 处理、静态资源、WS 握手 | `node test/manual/http-smoke.js` |
| `host-smoke.js` | 不起服务器，直接对引擎宿主做冒烟（握手、收草、tick、存档重载） | `node test/manual/host-smoke.js` |
| `postcard-check.js` | 渲染若干张明信片 PNG 到 `.audit-tmp/cards/`，用来目视检查合成结果 | `node test/manual/postcard-check.js` |
| `template-check.js` | 打印 webhook 模板在各种写法下的渲染结果与可解析性 | `node test/manual/template-check.js` |
| `push-receiver.js` | 本地推送接收端，监听 8899，把收到的请求写进 `received.jsonl`。用来在浏览器里验证「保存推送配置 + 发送测试推送」真的能发出 | `node test/manual/push-receiver.js` |
| `trigger-depart.js` | 给蛙备好行李并等它自己出门，然后打印推送日志，验证**真实事件**（不只手点测试）会自动触发推送 | `node test/manual/trigger-depart.js` |
| `show-received.js` | 把 `received.jsonl` 里的每条载荷排版打印出来 | `node test/manual/show-received.js` |

浏览器侧的验证（版权弹层、庭院渲染、零外域请求、双标签页同步）见 README
的「开发」一节与 `docs/decisions.md` 的 L2 —— 项目未引入 Playwright，
所以那部分是手动步骤，预期结果写在验收报告里。
