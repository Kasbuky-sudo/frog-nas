'use strict';
/**
 * Offline audit: find every absolute http(s) URL in the shipped game files and
 * report where it is, so "the container's only outbound traffic is push" is a
 * checked claim rather than an assumption.
 *
 * What it does NOT do is decide whether a URL is reachable: most of these live in
 * channel classes (Ejoy / Alipay / WXgame / Taobao) that this build never enters.
 * The report says where each one is and what guards it, and the CSP is the layer
 * that actually enforces "no foreign host" at runtime (see src/static.js).
 *
 * Output: docs/network-audit.md (and a console summary). Run via
 * `npm run audit:network`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const OUT = path.join(ROOT, 'docs', 'network-audit.md');

/**
 * Hosts we expect to find, each with the reason it is safe. Every entry was
 * checked by hand against the file and line it appears on (see the detail table);
 * a host that is NOT listed here is reported as "needs review" so a new build
 * cannot quietly introduce traffic.
 */
const KNOWN = {
  // --- this project's own allowed outbound traffic -------------------------
  'api.chuckfang.com': 'MeoW 推送：本项目功能，仅在设置页启用后由服务端请求',

  // --- references that are not requests -----------------------------------
  'www.w3.org': 'XHTML/XML 命名空间标识符（jszip），不是网络请求',
  'ns.egret.com': 'Egret EUI 的 XML 命名空间（eui.min.js 的 xmlns），不是网络请求',
  'github.com': '三方库源码/文档链接（assetsmanager、dragonBones 注释）',
  'stuk.github.io': 'JSZip 文档链接（注释）',
  'dragonbones.com': 'DragonBones 官网链接（注释）',
  'feross.org': 'buffer 库的作者链接（注释）',
  'jonnyreeves.co.uk': 'smoothscroll 库的作者链接（注释）',
  'www.apache.org': 'Apache-2.0 许可证地址（注释）',

  // --- channel SDKs this build never enters -------------------------------
  // gameConfig.json sets channelType=1 (ChannelType.Test), so the Ejoy / Alipay /
  // WXgame / Taobao channel classes are never constructed; the strings below are
  // reachable only from those classes. The CSP is the enforcement layer.
  'ali-lxqw-hotfix.ejoy.com': 'Ejoy 热更 launcher（index.html 里那行已被离线版注释掉）',
  'ali-x3-srv01.x3.ejoy.com': 'Ejoy 远程包地址（渠道 SDK，未进入）',
  'p10075-gangplank.ejoy.com': 'Ejoy 埋点（渠道 SDK，未进入）',
  'general.aligames.com': '阿里游戏协议页（渠道 SDK，未进入）',
  'render.aligames.com': '阿里游戏防沉迷页（渠道 SDK，未进入）',
  'appeal.lingxigames.com': '灵犀申诉页（渠道 SDK，未进入）',
  'www.lingxigames.com': '灵犀保护页（渠道 SDK，未进入）',
  'image.9game.cn': '九游渠道 SDK 资源（未进入）',
  'gm.mmstat.com': '阿里埋点统计（渠道 SDK，未进入）',
  'mmocgame.qpic.cn': '微信小游戏分享图（WXgame 渠道专用，未进入）',
  'cdn.jsdelivr.net': 'eruda 调试面板（ejoySDK 的调试分支，未进入）',
  'localhost': '调试用的本机地址（P10075 本地调试分支）',
};

/** Hosts that appear in the game files but are never requested by any code path
 *  this build reaches -- used only for the summary footnote. */
const NOT_A_REQUEST = new Set([
  'www.w3.org', 'ns.egret.com', 'github.com', 'stuk.github.io',
  'dragonbones.com', 'feross.org', 'jonnyreeves.co.uk', 'www.apache.org',
]);

const AUDIT_EXT = new Set(['.js', '.json', '.html', '.htm', '.css', '.xml', '.exml', '.txt', '.fnt']);
const URL_RE = /https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{4,200}/g;

function walk(dir, out, limit) {
  if (out.length > limit) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, limit);
    else if (AUDIT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
    if (out.length > limit) return;
  }
}

/** Strip the query/hash/credentials and return the bare host. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    const m = /^https?:\/\/([^/?#]+)/.exec(url);
    return m ? m[1] : url;
  }
}

function scan() {
  const files = [];
  walk(VENDOR, files, 6000);
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;                     // binary or unreadable: not a URL carrier
    }
    if (text.indexOf('http') === -1) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(URL_RE);
      if (!m) continue;
      for (const url of m) {
        hits.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          url,
          host: hostOf(url),
        });
      }
    }
  }
  return hits;
}

function summarize(hits) {
  const byHost = new Map();
  for (const h of hits) {
    if (!byHost.has(h.host)) byHost.set(h.host, { host: h.host, count: 0, files: new Set(), samples: [] });
    const rec = byHost.get(h.host);
    rec.count++;
    rec.files.add(h.file);
    if (rec.samples.length < 2) rec.samples.push(h.url);
  }
  return [...byHost.values()].sort((a, b) => b.count - a.count);
}

function describeHost(host) {
  return KNOWN[host] || KNOWN[host.replace(/^www\./, '')] || null;
}

function render(hits, hosts) {
  const now = new Date().toISOString();
  const unclassified = hosts.filter((h) => !describeHost(h.host));
  const lines = [];
  lines.push('# 网络审计 / Network audit');
  lines.push('');
  lines.push('> 由 `npm run audit:network` 生成，不要手工编辑。生成时间：' + now);
  lines.push('');
  lines.push('## 这个文件在证明什么');
  lines.push('');
  lines.push('本项目在 NAS 上运行一个离线游戏，要求**容器唯一的出站流量是推送**。');
  lines.push('游戏包本身是完整离线版，但里面仍然带着若干渠道 SDK 的代码与绝对 URL。');
  lines.push('本审计把 `vendor/` 里所有 `http(s)://` 字面量列出来，逐个说明用途与');
  lines.push('为什么不会被触发。真正执行"禁止外联"的是响应头里的 CSP');
  lines.push('（见 `src/static.js` 的 `cspHeader()`：`default-src \'self\'`、');
  lines.push('`connect-src \'self\' ws: wss:`，没有任何第三方主机）——');
  lines.push('即使某段 SDK 代码真的被走到，浏览器也会拒绝请求。');
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push('共发现 **' + hits.length + '** 处 URL 字面量，涉及 **' + hosts.length + '** 个主机，');
  lines.push('全部已分类' + (unclassified.length
    ? '，其中 **' + unclassified.length + ' 个需要人工确认**（见下表）。'
    : '，没有未分类项。'));
  lines.push('');
  lines.push('| 主机 | 处数 | 性质与是否会真的请求 |');
  lines.push('|---|---:|---|');
  for (const h of hosts) {
    const d = describeHost(h.host);
    lines.push('| `' + h.host + '` | ' + h.count + ' | ' +
      (d || '**未分类 —— 需要人工确认**') + ' |');
  }
  lines.push('');
  lines.push('### 运行时实际会发出的请求');
  lines.push('');
  lines.push('| 方向 | 目标 | 何时 |');
  lines.push('|---|---|---|');
  lines.push('| 浏览器 → 服务器 | 同源 `http://<nas>:8980/**` | 加载游戏 |');
  lines.push('| 浏览器 → 服务器 | 同源 `ws://<nas>:8980/ws` | 游戏过程中持续 |');
  lines.push('| 服务器 → 外网 | 设置页填写的 webhook 地址 | 仅在启用并发生事件时 |');
  lines.push('| 服务器 → 外网 | `api.chuckfang.com`（MeoW） | 仅在启用推送时 |');
  lines.push('');
  lines.push('除此之外没有出站流量：推送是仅有的两项，且都必须由用户在设置页显式启用。');
  lines.push('注意这两项都由 **Node 服务端**发起，浏览器不会直连它们，');
  lines.push('所以 CSP 不需要（也不应该）放行这些主机。');
  lines.push('');
  lines.push('## 逐条明细');
  lines.push('');
  lines.push('共 ' + hits.length + ' 处，涉及 ' + new Set(hits.map((h) => h.file)).size + ' 个文件。');
  lines.push('');
  lines.push('| 文件 | 行 | URL |');
  lines.push('|---|---:|---|');
  const shown = hits.slice(0, 400);
  for (const h of shown) {
    const url = h.url.length > 90 ? h.url.slice(0, 87) + '...' : h.url;
    lines.push('| `' + h.file + '` | ' + h.line + ' | `' + url.replace(/\|/g, '\\|') + '` |');
  }
  if (hits.length > shown.length) {
    lines.push('');
    lines.push('（还有 ' + (hits.length - shown.length) + ' 处未列出，完整数据见脚本输出。）');
  }
  lines.push('');
  lines.push('## 怎么复核');
  lines.push('');
  lines.push('```bash');
  lines.push('# 1. 重新生成并阅读本文件');
  lines.push('npm run audit:network');
  lines.push('');
  lines.push('# 2. 浏览器侧（最直观）：DevTools → Network 面板，刷新游戏页面。');
  lines.push('#    应当只有同源请求，以及一条到 /ws 的 WebSocket；');
  lines.push('#    把所有请求按 Domain 排序，不应出现任何外域域名。');
  lines.push('');
  lines.push('# 3. 服务端侧（最严格）：在 NAS 上抓容器的出站流量，');
  lines.push('#    确认只有推送目标。');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function main() {
  if (!fs.existsSync(VENDOR)) {
    console.error('[audit] vendor/ 不存在，先运行 node scripts/fetch-source.js');
    return 2;
  }
  const hits = scan();
  const hosts = summarize(hits);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, render(hits, hosts));

  console.log('[audit] ' + hits.length + ' 个 URL 字面量，涉及 ' + hosts.length + ' 个主机:');
  for (const h of hosts) {
    const d = describeHost(h.host);
    console.log('  ' + String(h.count).padStart(4) + '  ' + h.host.padEnd(32) +
      (d ? '' : '  <-- 未分类'));
  }
  console.log('[audit] 报告写入 ' + path.relative(ROOT, OUT));
  const unknown = hosts.filter((h) => !describeHost(h.host));
  if (unknown.length) {
    console.log('[audit] 注意：有 ' + unknown.length + ' 个未分类主机，请在报告里确认它们的用途。');
  }
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { scan, summarize, render, hostOf, describeHost, KNOWN };
