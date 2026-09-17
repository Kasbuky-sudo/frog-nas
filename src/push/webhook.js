'use strict';
/**
 * Channel: custom Webhook.
 *
 * The operator configures a URL, extra headers and a body template. Placeholders
 * {{event}} {{title}} {{body}} {{timestamp}} {{url}} {{image}} are substituted from
 * the notification; with no template a small but complete JSON body is sent (see
 * renderWebhookBody) so "paste a webhook.site URL and go" works with no authoring.
 *
 * The body is sent as application/json when the rendered template parses as JSON
 * and as text/plain otherwise, which makes both `{"text":"{{title}} {{body}}"}`
 * and a bare `{{title}} {{body}}` do the obvious thing.
 */
/**
 * Default body: `data` is unquoted so the event's own payload arrives as a real
 * nested JSON object (renderJsonTemplate handles the quoted/unquoted difference).
 * Placeholders {{event}} {{title}} {{body}} {{timestamp}} {{url}} {{image}} are
 * inside quoted slots, so their values are escaped as JSON strings.
 */
const DEFAULT_TEMPLATE = JSON.stringify({
  event: '{{event}}',
  title: '{{title}}',
  body: '{{body}}',
  timestamp: '{{timestamp}}',
  url: '{{url}}',
  image: '{{image}}',
  data: '{{data}}',
}, null, 2)
  // JSON.stringify puts quotes around the data placeholder; drop just those two.
  .replace('"{{data}}"', '{{data}}');

/**
 * Placeholder substitution. Unknown placeholders are left alone (so a literal
 * {{ in a message does not silently disappear).
 *
 * Escaping: `{{dataJson}}` / raw JSON values are inserted with their quotes
 * escaped, so they remain valid inside a JSON string literal. `{{data}}` inserts
 * the object literal verbatim, which is only correct when the surrounding text is
 * JSON syntax rather than a quoted value.
 *
 * Two render modes are therefore distinguished, because a naive string replace
 * cannot know whether the placeholder sits inside quotes:
 *   - renderJsonTemplate: every placeholder is treated as a JSON value (it is
 *     quote-escaped when inserted inside a quoted slot, raw when it is not);
 *   - render: plain text substitution, used when the rendered result is not JSON.
 */
function escapeJsonString(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function render(template, vars) {
  return String(template).replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] == null ? '' : vars[key]) : m;
  });
}

/**
 * Render a template that is meant to be JSON.
 *
 * The scanner tracks whether the cursor is inside a JSON string literal, because
 * that is what decides how a value may be inserted:
 *   - inside a string  -> the value is escaped and spliced in as string content;
 *   - outside a string -> the value is JSON-encoded, so a nested object or array
 *     survives as a real nested value and a plain string gets its quotes.
 *
 * A single regex cannot do this (it cannot see the surrounding quotes), which is
 * how an earlier version produced `"{"a":1}"` and broke the JSON it emitted.
 */
function renderJsonTemplate(template, vars) {
  const s = String(template);
  let out = '';
  let i = 0;
  let inString = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      // Not in a string: this opens one. Inside a string: this closes it, unless
      // it is escaped (handled below).
      inString = !inString;
      out += c;
      i++;
      continue;
    }
    if (inString && c === '\\') {
      out += s.slice(i, i + 2);      // keep the escape pair intact
      i += 2;
      continue;
    }
    if (c === '{' && s[i + 1] === '{') {
      const end = s.indexOf('}}', i);
      if (end > 0) {
        const key = s.slice(i + 2, end).trim();
        if (Object.prototype.hasOwnProperty.call(vars, key)) {
          const v = vars[key];
          if (inString) {
            out += escapeJsonString(typeof v === 'object' && v !== null ? JSON.stringify(v) : (v == null ? '' : v));
          } else {
            out += v === undefined ? 'null' : JSON.stringify(v);
          }
          i = end + 2;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * @param {object} note     {event, title, body, data, url, image}
 * @param {object} channel  settings.webhook
 * @returns {{contentType: string, body: string, vars: object}}
 */
function renderWebhookBody(note, channel) {
  const vars = {
    event: note.event,
    title: note.title,
    body: note.body,
    timestamp: new Date(note.at * 1000).toISOString(),
    url: note.url || '',
    image: note.image || '',
    // The event's own payload. `data` renders as nested JSON when it stands alone
    // as a value; `dataJson` is always the stringified form.
    data: note.data || {},
    dataJson: JSON.stringify(note.data || {}),
  };
  const template = (channel && channel.template) || DEFAULT_TEMPLATE;
  const wantsText = !!(channel && channel.contentType === 'text');
  if (wantsText) {
    return { contentType: 'text/plain; charset=utf-8', body: render(template, vars), vars };
  }
  const body = renderJsonTemplate(template, vars);
  let contentType = 'text/plain; charset=utf-8';
  try {
    JSON.parse(body);
    contentType = 'application/json; charset=utf-8';
  } catch (e) {
    // A template that is not JSON (Slack-style "{{title}} {{body}}") is sent as
    // text rather than being forced through a JSON wrapper that would escape it.
    // Re-render in text mode so the values are not left quote-escaped.
    return { contentType: 'text/plain; charset=utf-8', body: render(template, vars), vars };
  }
  return { contentType, body, vars };
}

/**
 * @returns {Promise<{ok: boolean, status?: number, error?: string, ms: number}>}
 */
async function send(note, channel, opts) {
  const started = Date.now();
  const url = channel && channel.url;
  if (!url) return { ok: false, error: 'webhook url 未配置', ms: 0 };
  const { contentType, body } = renderWebhookBody(note, channel);
  const headers = { 'Content-Type': contentType, ...(channel.headers || {}) };
  const timeoutMs = (opts && opts.timeoutMs) || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      error: res.ok ? undefined : 'HTTP ' + res.status,
      ms: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false,
      error: e.name === 'AbortError' ? '超时(' + timeoutMs + 'ms)' : String(e.message || e),
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { send, render, renderJsonTemplate, renderWebhookBody, DEFAULT_TEMPLATE };
