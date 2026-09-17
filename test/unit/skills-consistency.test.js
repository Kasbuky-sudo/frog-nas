'use strict';
/**
 * Consistency tests: the documents must match the server.
 *
 * These exist because the SKILL.md files and openapi.json are prose that a future
 * edit can silently desynchronise from the router. Both are checked against the
 * real Express router that `src/api/index.js` builds, not against a copy.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..', '..');
const { createApiRouter } = require('../../src/api');
const { SKILLS, SKILL_NAMES, skillsIndex, parseFrontmatter } = require('../../src/skills');
const { buildOpenApi, DOCUMENTED } = require('../../src/openapi');

/** Where src/server.js mounts the API router, and where the skills address it. */
const API_MOUNT = '/api';

/**
 * Build the API router with the smallest set of collaborators that let it mount.
 * Anything the router touches at construction time must be present; nothing here
 * is ever dispatched against in this file.
 */
function mountRouter() {
  const app = express();
  const stub = {
    host: { ready: true, state: {}, startedAt: Date.now(), saveInfo: () => ({}), saveFiles: () => [] },
    gd: { define: { scalars: {} }, shopList: () => [], guestFavourites: () => [], tables: {} },
    bot: { call: () => ({ reply: {}, pushes: [], handled: true }), info: () => ({}) },
    settings: { checkToken: () => true, get: () => ({}) },
    push: { publicConfig: () => ({}), recentLogs: () => [], test: async () => ({ ok: true }) },
    bridge: { clients: new Set() },
    openapi: buildOpenApi(),
    readClientLog: () => [],
  };
  app.use('/api', createApiRouter(stub));
  return app;
}

/**
 * Every method+path the router registered, as a caller would address it.
 *
 * Express exposes only the path RELATIVE to the mount (`/health` for a route
 * declared on a router mounted at `/api`), and recovering the mount from the
 * layer's compiled regexp is fiddly. The mount is known -- src/server.js always
 * does `app.use('/api', ...)`, and the OpenAPI document declares `/api` as its
 * server url -- so it is passed in explicitly instead.
 *
 * Parameters are normalised from Express's `:name` to OpenAPI's `{name}`.
 */
function registeredRoutes(app, mount) {
  const out = [];
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        const p = (mount + layer.route.path).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
        for (const m of Object.keys(layer.route.methods)) {
          if (layer.route.methods[m]) out.push(m.toUpperCase() + ' ' + p);
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(app._router.stack);
  return out;
}

/** Documentation paths as a caller addresses them: the OpenAPI document declares
 *  `servers: [{url: '/api'}]`, so its path keys are relative to that mount. */
const documentedRoutes = () => DOCUMENTED.map((r) => {
  const sp = r.indexOf(' ');
  return r.slice(0, sp + 1) + API_MOUNT + r.slice(sp + 1);
});

test('openapi: every documented route exists on the router', () => {
  const real = new Set(registeredRoutes(mountRouter(), API_MOUNT));
  for (const doc of documentedRoutes()) {
    assert.ok(real.has(doc), 'documented but not implemented: ' + doc);
  }
});

test('openapi: every implemented route is documented', () => {
  const documented = new Set(documentedRoutes());
  const missing = registeredRoutes(mountRouter(), API_MOUNT).filter((r) => !documented.has(r));
  assert.deepEqual(missing, [], 'implemented but undocumented: ' + JSON.stringify(missing));
});

test('openapi: /health is the only unauthenticated route', () => {
  const { paths } = buildOpenApi();
  const open = Object.entries(paths)
    .filter(([, methods]) => Object.values(methods).some((op) => op.security && op.security.length === 0))
    .map(([p]) => p);
  assert.deepEqual(open, ['/health']);
});

test('openapi: the document is serialisable and self-consistent', () => {
  const doc = buildOpenApi();
  assert.equal(doc.openapi, '3.0.3');
  assert.ok(doc.info.title && doc.info.version);
  const round = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(round.paths, doc.paths);
  for (const [p, methods] of Object.entries(doc.paths)) {
    assert.ok(p.startsWith('/'), 'path must be relative to the server root: ' + p);
    for (const [m, op] of Object.entries(methods)) {
      assert.ok(op.summary, m.toUpperCase() + ' ' + p + ' has no summary');
      assert.ok(op.responses && Object.keys(op.responses).length, m.toUpperCase() + ' ' + p + ' has no responses');
    }
  }
});

test('skills: all five exist with frontmatter name and description', () => {
  assert.deepEqual(SKILLS.map((s) => s.name), SKILL_NAMES);
  assert.equal(SKILLS.length, 5);
  for (const s of SKILLS) {
    assert.ok(s.description.length > 20, s.name + ': description too short');
    assert.ok(/[\u4e00-\u9fa5]/.test(s.description), s.name + ': description needs a Chinese sentence');
    assert.ok(/[A-Za-z]{6,}/.test(s.description), s.name + ': description needs an English sentence');
    assert.ok(s.body.length > 500, s.name + ': body looks empty');
    assert.equal(s.path, '/skills/' + s.name + '/SKILL.md');
  }
});

test('skills: every /api path in a SKILL.md is a real route', () => {
  const real = new Set(registeredRoutes(mountRouter(), API_MOUNT));

  // Collect "/api/..." occurrences from the curl examples and prose. The skills
  // address the API exactly as a caller does (including the /api prefix), which is
  // what `real` contains.
  const refRe = /\/api\/[A-Za-z0-9_\-{}/.:]*/g;
  for (const s of SKILLS) {
    const found = new Set(s.body.match(refRe) || []);
    assert.ok(found.size > 0, s.name + ' references no API path');
    for (const ref of found) {
      // Normalise a trailing punctuation run and any query string.
      const clean = ref.replace(/[.,;:)\]}"']+$/, '').split('?')[0].replace(/\/$/, '');
      // A concrete skill name addresses the parameterised route.
      const candidates = [/^\/api\/skills\/[^/]+$/.test(clean) && clean !== '/api/skills'
        ? '/api/skills/{name}'
        : clean];
      const ok = candidates.some((c) =>
        real.has('GET ' + c) || real.has('POST ' + c) || real.has('PUT ' + c) || real.has('DELETE ' + c));
      assert.ok(ok, s.name + ': references a path that does not exist: ' + ref +
        ' (known: ' + [...real].join(', ') + ')');
    }
  }
});

test('skills: every documented request field is one the route reads', () => {
  // The fields the SKILL.md files tell an agent to send, per endpoint.
  const EXPECTED = {
    '/api/harvest': ['slot', 'slots'],
    '/api/luggage': ['slots', 'items'],
    '/api/table': ['slots', 'items'],
    '/api/shop/buy': ['shopId', 'itemId', 'qty'],
    '/api/visitor/feed': ['visitorId', 'itemId', 'auto'],
    '/api/mail/claim': ['id', 'ids'],
  };
  const routerSource = fs.readFileSync(path.join(ROOT, 'src', 'api', 'index.js'), 'utf8');
  for (const [, fields] of Object.entries(EXPECTED)) {
    for (const f of fields) {
      assert.ok(routerSource.includes(f), 'router never mentions documented field: ' + f);
    }
  }
  // And the values the skills quote must appear in the route source too.
  for (const token of ['clover_id', 'visitorId', 'shop_id', 'is_reward']) {
    assert.ok(routerSource.includes(token), 'router is missing ' + token);
  }
});

test('skills: documented response fields for /api/state exist in the projection', () => {
  const viewSource = fs.readFileSync(path.join(ROOT, 'src', 'state-view.js'), 'utf8');
  for (const field of ['status', 'away', 'returnInSec', 'nextDepartAt', 'waitingForBag',
    'prepared', 'readySlots', 'nextReadyAt', 'feedableSpecialtys', 'unread']) {
    assert.ok(viewSource.includes(field), '/api/state does not produce documented field: ' + field);
  }
});

test('skills: the status skill documents that the destination is withheld', () => {
  const status = SKILLS.find((s) => s.name === 'frog-status');
  assert.match(status.body, /目的地/,
    'the skill must tell an agent not to promise a destination the API hides');
});

test('/api/skills payload lists every skill with a fetchable url', () => {
  const idx = skillsIndex();
  assert.equal(idx.count, 5);
  for (const s of idx.skills) {
    assert.equal(s.url, '/api/skills/' + s.name);
    assert.ok(s.description.length > 20);
    assert.ok(s.bytes > 500);
  }
});

test('/api/skills/:name serves the exact file body', () => {
  for (const s of SKILLS) {
    const disk = fs.readFileSync(path.join(ROOT, 'skills', s.name, 'SKILL.md'), 'utf8');
    const { body } = parseFrontmatter(disk);
    assert.equal(s.body, body.trim(), s.name + ': API body differs from the file');
  }
});

test('skills/:name is readable as a plain file too (no build step)', () => {
  for (const name of SKILL_NAMES) {
    const p = path.join(ROOT, 'skills', name, 'SKILL.md');
    assert.ok(fs.existsSync(p), 'missing ' + p);
  }
});
