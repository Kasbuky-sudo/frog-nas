'use strict';
/**
 * Channel: MeoW (鸿蒙推送服务).
 *
 * Docs: https://www.chuckfang.com/MeoW/api_doc.html
 *
 * The API identifies a recipient by NICKNAME alone -- there is no token or device
 * id -- which is why the setting is called `nickname` and why a typo simply means
 * "not delivered" rather than an auth error.
 *
 *   POST {base}/{nickname}
 *     body: {"title","msg","url"?,"imgUrl"?}   Content-Type: application/json
 *
 *   GET  {base}/{nickname}/{title}/{msg}?url=&imgUrl=&msgType=text|html&htmlHeight=200
 *
 * Success is `{"status":200,"msg":"推送成功"}`. Anything else (including HTTP 200
 * with a different `status`) counts as a failure, because the service reports
 * application-level errors in the body.
 *
 * POST is preferred: it takes a JSON body, so titles containing `/`, `?` or Chinese
 * punctuation do not need path escaping. GET is kept for base URLs that reject POST.
 */
const DEFAULT_BASE = 'https://api.chuckfang.com';

/** @returns {Promise<{ok:boolean, status?:number, body?:any, mode:string, error?:string, ms:number}>} */
async function send(note, channel, opts) {
  const started = Date.now();
  const nickname = channel && channel.nickname;
  if (!nickname) return { ok: false, mode: 'none', error: 'MeoW 昵称未配置', ms: 0 };
  const base = String((channel && channel.apiBase) || DEFAULT_BASE).replace(/\/+$/, '');
  const mode = (channel && channel.method) === 'GET' ? 'GET' : 'POST';
  const timeoutMs = (opts && opts.timeoutMs) || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const msgType = (channel && channel.msgType) || 'text';
  const imgUrl = (note.image || (channel && channel.imgUrl) || '') || undefined;
  const linkUrl = (note.url || (channel && channel.url) || '') || undefined;

  try {
    let res;
    if (mode === 'POST') {
      const payload = { title: note.title, msg: note.body };
      if (linkUrl) payload.url = linkUrl;
      if (imgUrl) payload.imgUrl = imgUrl;
      res = await fetch(base + '/' + encodeURIComponent(nickname), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } else {
      const qs = new URLSearchParams();
      if (linkUrl) qs.set('url', linkUrl);
      if (imgUrl) qs.set('imgUrl', imgUrl);
      qs.set('msgType', msgType);
      if (msgType === 'html') qs.set('htmlHeight', String((channel && channel.htmlHeight) || 200));
      const path = '/' + encodeURIComponent(nickname)
        + '/' + encodeURIComponent(note.title)
        + '/' + encodeURIComponent(note.body);
      res = await fetch(base + path + '?' + qs.toString(), { method: 'GET', signal: controller.signal });
    }

    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { /* keep the raw body below */ }
    // An HTTP error is a failure regardless of the body; a 200 whose `status` is
    // not 200 is also a failure (that is how MeoW reports a bad nickname).
    const appOk = parsed && Number(parsed.status) === 200;
    const ok = res.ok && appOk;
    return {
      ok,
      mode,
      status: res.status,
      body: parsed || text.slice(0, 300),
      error: ok ? undefined
        : (parsed && parsed.msg ? String(parsed.msg) : 'HTTP ' + res.status),
      ms: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false,
      mode,
      error: e.name === 'AbortError' ? '超时(' + timeoutMs + 'ms)' : String(e.message || e),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { send, DEFAULT_BASE };
