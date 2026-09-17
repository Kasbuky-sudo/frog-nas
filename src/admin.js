'use strict';
/**
 * /admin: the operator's settings page.
 *
 * Access is either open (default: adminCode is empty) or gated by an access code
 * typed into the page and kept in a cookie. The code is a convenience, not a
 * security boundary -- the page exposes the API token, so the real advice is "do
 * not expose port 8980 to the internet". That is stated on the page itself.
 *
 * The page is plain HTML + fetch, no build step, so it can be edited in place.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { EDITABLE_ENV } = require('./settings');

const COOKIE = 'frog_admin';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAdminRouter(ctx) {
  const { settings, host, dispatcher, gd, bot, bridge, dataDir } = ctx;
  const router = express.Router();

  const requireCode = (req, res, next) => {
    const cfg = settings.get();
    if (!cfg.adminCode) { next(); return; }
    const cookies = parseCookies(req.headers.cookie);
    const provided = cookies[COOKIE] || req.headers['x-admin-code'] || (req.body && req.body.code);
    if (settings.checkAdminCode(provided)) { next(); return; }
    if (req.path === '/login') { next(); return; }
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: { code: 'unauthorized', message: '需要访问码' } });
      return;
    }
    res.status(401).type('text/html').send(loginPage());
  };

  router.use(requireCode);

  router.get('/login', (req, res) => {
    res.type('text/html').send(loginPage());
  });

  router.post('/login', (req, res) => {
    const code = (req.body && req.body.code) || '';
    if (settings.checkAdminCode(code) && settings.get().adminCode) {
      res.setHeader('Set-Cookie', COOKIE + '=' + encodeURIComponent(code) + '; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=604800');
      res.json({ ok: true });
    } else {
      res.status(401).json({ ok: false, error: '访问码不对' });
    }
  });

  router.get('/', (req, res) => {
    res.type('text/html').send(adminPage());
  });

  // ------------------------------------------------------------ state
  router.get('/api/overview', (req, res) => {
    const s = host.state;
    res.json({
      engine: {
        ready: host.ready,
        uptimeSec: Math.floor((Date.now() - host.startedAt) / 1000),
        env: settings.engineEnv(),
        saveDir: path.relative(process.cwd(), path.join(dataDir, 'save')),
        saveInfo: host.saveInfo(),
        saves: host.saveFiles().slice(0, 12),
      },
      save: {
        name: s.name, clover: s.clover, ticket: s.ticket,
        frogStatus: s.frog && s.frog.status,
        pictures: (s.pictures || []).length,
        specialtys: (s.specialtys || []).length,
        mails: (s.mails || []).length,
        guest: s.guest ? s.guest.id : null,
        tripCount: (s.travel || {}).tripCount || 0,
      },
      bot: bot.info(),
      ws: {
        clients: bridge.clients.size,
        stats: bridge.stats,
      },
      push: dispatcher.publicConfig(),
      apiToken: settings.get().apiToken,
      requireToken: settings.tokenRequired(),
      adminCodeSet: !!settings.get().adminCode,
      publicUrl: settings.get().publicUrl || '',
      editableEnv: EDITABLE_ENV,
      envCatalog: ENV_HELP,
      tz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  // -------------------------------------------------------- push config
  router.put('/api/push', (req, res) => {
    const updated = settings.update({ push: req.body || {} });
    dispatcher.reload(updated.push);
    res.json({ ok: true, push: dispatcher.publicConfig() });
  });

  router.post('/api/push/test', async (req, res) => {
    const results = await dispatcher.test(req.body || {});
    res.json(results);
  });

  router.get('/api/push/logs', (req, res) => {
    res.json({ entries: dispatcher.recentLogs(Number(req.query.limit) || 100) });
  });

  // ---------------------------------------------------------- engine env
  router.put('/api/engine-env', (req, res) => {
    const body = req.body || {};
    const next = {};
    for (const [k, v] of Object.entries(body.env || {})) {
      if (!EDITABLE_ENV.includes(k)) continue;          // only the documented knobs
      const s = String(v).trim();
      if (s === '') continue;
      next[k] = s;
    }
    const updated = settings.update({ engine: { env: next } });
    // Restarting re-reads the save from disk, so an env change takes effect now.
    host.restart(require('./server').envWithOverrides(settings.engineEnv()));
    bot.login();
    dispatcher.reload(updated.push);
    dispatcher.prime();
    res.json({ ok: true, env: settings.engineEnv() });
  });

  // ------------------------------------------------------------- secrets
  router.post('/api/token/reset', (req, res) => {
    res.json({ ok: true, apiToken: settings.resetToken() });
  });

  router.put('/api/require-token', (req, res) => {
    const on = !!(req.body && req.body.requireToken);
    settings.update({ requireToken: on });
    res.json({ ok: true, requireToken: on });
  });

  router.put('/api/admin-code', (req, res) => {
    const code = String((req.body && req.body.code) || '');
    settings.update({ adminCode: code });
    res.json({ ok: true, adminCodeSet: !!code });
  });

  router.put('/api/public-url', (req, res) => {
    const url = String((req.body && req.body.url) || '').trim();
    settings.update({ publicUrl: url });
    res.json({ ok: true, publicUrl: url });
  });

  // --------------------------------------------------------------- save
  router.get('/api/save/export', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="frog-save.json"');
    res.type('application/json').send(JSON.stringify(host.exportSave(), null, 2));
  });

  router.post('/api/save/import', (req, res) => {
    const body = req.body || {};
    if (body.confirm !== true) {
      res.status(400).json({ error: { code: 'confirm_required', message: '导入会覆盖当前存档，需要 confirm:true' } });
      return;
    }
    const payload = body.save || body;
    try {
      host.importSave(payload);
      bot.login();
      dispatcher.prime();
      res.json({ ok: true, saveInfo: host.saveInfo() });
    } catch (e) {
      res.status(400).json({ error: { code: 'bad_save', message: String(e.message || e) } });
    }
  });

  router.post('/api/save/reset', (req, res) => {
    const body = req.body || {};
    if (body.confirm !== true) {
      res.status(400).json({ error: { code: 'confirm_required', message: '重置会清空进度，需要 confirm:true' } });
      return;
    }
    // The engine's own GM command is the supported reset: it writes a fresh
    // defaultState through the normal save path (so the old save is archived by
    // the engine's own backup step rather than being deleted by us).
    const r = bot.call('client_gm', { cmd: 'reset_save' });
    bot.login();
    dispatcher.prime();
    res.json({ ok: true, reply: r.reply, saveInfo: host.saveInfo() });
  });

  router.get('/api/save/download/:name', (req, res) => {
    // Only names that exist in the save dir, resolved inside it: no traversal.
    const dir = path.join(dataDir, 'save');
    const name = path.basename(req.params.name);
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { res.status(404).json({ error: { code: 'not_found', message: name } }); return; }
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.type('application/json').sendFile(file);
  });

  // --------------------------------------------------------------- logs
  router.get('/api/client-logs', (req, res) => {
    const file = path.join(dataDir, 'logs', 'client.log');
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch (e) { /* no log yet */ }
    const limit = Number(req.query.limit) || 200;
    res.json({ lines: lines.slice(-limit).reverse() });
  });

  return router;
}

/** Human-readable help for each editable env knob, shown next to the input. */
const ENV_HELP = {
  FROG_FAITHFUL: '1 = 用原版真实时长（默认）。0 = 用离线版缩短的时长，适合快速试玩。',
  FROG_TRAVEL_MIN: '单次旅行最短秒数（FAITHFUL=1 时为 3600）',
  FROG_TRAVEL_MAX: '单次旅行最长秒数（FAITHFUL=1 时为 21600）',
  FROG_IDLE_MIN: '回家后最短多久再出门（秒）',
  FROG_IDLE_MAX: '回家后最长多久再出门（秒）',
  FROG_WAIT_MIN: '没准备行李时的重试间隔下限（秒）',
  FROG_WAIT_MAX: '没准备行李时的重试间隔上限（秒）',
  FROG_DRIFT_MIN: '放浪（没带便当）最短回家时间（秒）',
  FROG_DRIFT_MAX: '放浪最长回家时间（秒）',
  FROG_GUEST_ROLL: '邻居访客掷骰间隔（秒）',
  FROG_GUEST_CHANCE: '每次掷骰出访客的百分比',
  FROG_VISITOR_ROLL: '串门访客掷骰间隔（秒）',
  FROG_VISITOR_CHANCE: '每次掷骰出串门访客的百分比',
  FROG_VISITOR_STAY: '串门访客停留秒数',
  FROG_VISITOR_COOL: '串门访客冷却秒数',
  FROG_DRAWING_ROLL: '友情绘本来客掷骰间隔（秒）',
  FROG_DRAWING_CHANCE: '友情绘本掷骰百分比',
  FROG_DRAWING_TRIP: '友情绘本外出秒数',
  FROG_LOTTERY_ROLL: '抽奖活动掷骰间隔（秒）',
  FROG_LOTTERY_CHANCE: '抽奖活动出现概率（%）',
  FROG_LOTTERY_OPTIONS: '抽奖可选奖品数量下限',
  FROG_SHOP_HOURS: '商店限时商品开关（小时，0 = 关闭）',
  FROG_PLANT_STAGE_SEC: '花盆每阶段生长秒数',
  FROG_CRAFT_SEC: '工作台制作耗时（秒）',
  FROG_MOTION_SEC: '蛙在家时动作切换间隔（秒）',
  FROG_WISH_POOL_DAYS: '许愿池开放天数',
  FROG_WISH_COINS_PER_DAY: '许愿池每天补多少许愿币',
  FROG_WISH_COIN_MAX: '许愿币上限',
  FROG_CAPSULE_DAYS: '扭蛋活动持续天数',
  FROG_CAPSULE_COIN: '扭蛋活动初始币数',
  FROG_DECORATION_CHANCE: '庭院装饰掉落概率（%）',
  FROG_GUEST_CLOVER_POW: '访客带来的三叶草基数',
  FROG_VISITOR_FOOD_MAX: '串门访客食物上限',
  FROG_TRAVEL_STEPS: '一次旅行的最大步数',
  FROG_TRAVEL_GOAL_STEPS: '多少步之后才算“到达目的地”',
  FROG_TRAVEL_MINUTES: '步行预算系数（相对 TRAVEL_TIME_MIN）',
};

function loginPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>旅行青蛙 · 设置</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#f6f2e6;color:#4a4437;
     display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#fff;padding:28px 26px;border-radius:10px;box-shadow:0 2px 14px rgba(0,0,0,.08);text-align:center}
h1{font-size:17px;margin:0 0 16px}
input{font-size:15px;padding:9px 12px;border:1px solid #d8d2c4;border-radius:6px;width:200px}
button{margin-top:14px;font-size:15px;padding:9px 22px;border:1px solid #7a9a5b;background:#7a9a5b;color:#fff;
       border-radius:6px;cursor:pointer}
#msg{color:#b4483c;font-size:13px;margin-top:10px;min-height:18px}
</style></head><body>
<form id="f"><h1>请输入访问码</h1>
<input id="code" type="password" autocomplete="current-password" autofocus>
<div><button type="submit">进入</button></div><div id="msg"></div></form>
<script>
document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();
 const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({code:document.getElementById('code').value})});
 if(r.ok)location.reload();else document.getElementById('msg').textContent='访问码不对';});
</script></body></html>`;
}

function adminPage() {
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
}

module.exports = { createAdminRouter, ENV_HELP };
