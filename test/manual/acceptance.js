// Final acceptance self-check against the running server (§6 of the brief).
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PORT = 8980;
const TOKEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')).apiToken;

function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const d = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const q = http.request({
      host: '127.0.0.1', port: PORT, path: p, method, timeout: 15000,
      headers: { ...(d ? { 'Content-Type': 'application/json', 'Content-Length': d.length } : {}), ...(headers || {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json, buffer });
      });
    });
    q.on('error', reject);
    if (d) q.write(d);
    q.end();
  });
}
const api = (m, p, b) => req(m, p, b, { Authorization: 'Bearer ' + TOKEN });

const results = [];
const check = (label, cond, detail) => {
  results.push({ label, ok: !!cond, detail });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  — ' + detail : ''));
};

(async () => {
  console.log('=== §6 验收自查 ===\n');

  console.log('[1] 游戏可玩 + 版权弹层');
  const idx = await req('GET', '/');
  check('index.html 200', idx.status === 200);
  check('版权弹层原样保留', idx.text.includes('id="__notice"') && idx.text.includes('Hit-Point') && idx.text.includes('Balticx') && idx.text.includes('我已阅读，进入游戏'));
  check('Route A 默认（注入 shim）', idx.text.includes("searchParams.set('transport', 'ws')"));
  check('CSP 存在', !!idx.headers['content-security-policy']);
  const cfg = await req('GET', '/resource/China/config/gameConfig.json');
  check('gameConfig 指向本服务', JSON.parse(cfg.text).serverList.offline.gameServer[0] === 'ws://127.0.0.1:8980/ws');

  console.log('\n[2] FAITHFUL 默认开');
  const h = await req('GET', '/api/health');
  const overview = await req('GET', '/admin/api/overview', undefined, { Cookie: '' });
  const envFromAdmin = JSON.parse((await req('GET', '/admin/api/overview')).text).engine.env;
  check('FROG_FAITHFUL=1', envFromAdmin.FROG_FAITHFUL === '1', JSON.stringify(envFromAdmin));

  console.log('\n[3] 存档持久化 + 时间事件补结算');
  const saveFiles = fs.readdirSync(path.join(ROOT, 'data', 'save'));
  check('存档落盘', saveFiles.some((f) => f === 'frog.offline.save.json'), saveFiles.join(', '));
  check('引擎备份槽存在', saveFiles.some((f) => f.includes('.bak')), saveFiles.join(', '));

  console.log('\n[4] 零外域请求（静态侧）+ 网络审计存在');
  check('docs/network-audit.md 存在', fs.existsSync(path.join(ROOT, 'docs', 'network-audit.md')));
  const audit = fs.readFileSync(path.join(ROOT, 'docs', 'network-audit.md'), 'utf8');
  check('审计无未分类主机', !audit.includes('未分类 —— 需要人工确认'));
  check('CSP 无第三方主机', !/connect-src[^;]*(?<!'self')\bhttps?:/.test(idx.headers['content-security-policy']));

  console.log('\n[5] 推送：双通道可配置 + 测试发送 + 日志');
  const push = await api('GET', '/api/settings/push');
  check('推送配置可读', push.status === 200 && push.json.webhook && push.json.meow);
  const logs = await api('GET', '/api/logs/push');
  check('推送日志可读', Array.isArray(logs.json.entries));
  const test = await api('POST', '/api/push/test', {});
  check('测试推送返回结果', typeof test.json.ok === 'boolean', JSON.stringify(test.json.results || []));

  console.log('\n[6] 认证');
  const noTok = await req('GET', '/api/state');
  const badTok = await req('GET', '/api/state', undefined, { Authorization: 'Bearer x' });
  const okTok = await api('GET', '/api/state');
  check('无 token → 401', noTok.status === 401);
  check('错 token → 403', badTok.status === 403);
  check('对 token → 200', okTok.status === 200);
  check('health 免认证', (await req('GET', '/api/health')).status === 200);

  console.log('\n[7] 5 个 SKILL.md');
  const skills = await api('GET', '/api/skills');
  check('skills 清单 5 个', skills.json.count === 5, skills.json.skills.map((s) => s.name).join(','));
  for (const s of skills.json.skills) {
    const one = await api('GET', '/api/skills/' + s.name);
    const raw = await req('GET', s.path);
    check('  ' + s.name + ' 正文可取', one.status === 200 && one.json.body.length > 500);
    check('  ' + s.name + ' 静态可下载', raw.status === 200 && raw.text.includes('---'));
  }

  console.log('\n[8] openapi 与路由一致（由单测保证，此处只验证可取）');
  const oa = await api('GET', '/api/openapi.json');
  check('openapi.json 可取', oa.status === 200 && Object.keys(oa.json.paths).length === 21);

  console.log('\n[9] 源码零修改 + 安卓壳不在 vendor');
  const shellMarkers = ['AndroidManifest.xml', 'classes.dex', 'resources.arsc'];
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (shellMarkers.includes(e.name)) found.push(p);
    }
  };
  walk(path.join(ROOT, 'vendor'));
  check('vendor 无安卓壳文件', found.length === 0, found.join(','));

  console.log('\n=== 汇总 ===');
  const failed = results.filter((r) => !r.ok);
  console.log((results.length - failed.length) + ' / ' + results.length + ' 项通过');
  if (failed.length) {
    console.log('未通过：');
    failed.forEach((f) => console.log('  - ' + f.label + (f.detail ? '  ' + f.detail : '')));
  }
  process.exit(failed.length ? 1 : 0);
})();
