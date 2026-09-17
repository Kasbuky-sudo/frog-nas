'use strict';
/**
 * The skill catalogue, read from skills/<name>/SKILL.md.
 *
 * The files are the single source of truth: /api/skills serves them verbatim and
 * they are also downloadable as static files, so an agent that reads the JSON and
 * an agent that reads the directory see the same text. The API paths mentioned in
 * a SKILL.md are cross-checked against the real router by
 * test/unit/skills-consistency.test.js, which is what keeps these documents from
 * drifting away from the server.
 */
const fs = require('fs');
const path = require('path');

const SKILL_NAMES = [
  'frog-status',
  'frog-harvest',
  'frog-prepare',
  'frog-visitor',
  'frog-lottery',
];

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

/** Split YAML frontmatter from the body. Only `key: value` pairs are parsed --
 *  the frontmatter in these files is deliberately flat. */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

/** Read one skill from disk. Returns null when the file is missing. */
function readSkill(name) {
  const rel = path.join('skills', name, 'SKILL.md');
  const file = path.join(SKILLS_DIR, name, 'SKILL.md');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  return {
    name: meta.name || name,
    description: meta.description || '',
    /** Web path, so an agent can fetch the raw file instead of the JSON. */
    path: '/' + rel.replace(/\\/g, '/'),
    body: body.trim(),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

/** All skills, in the deliberate teaching order (status first: it is the
 *  prerequisite for every other decision). */
function loadSkills() {
  const out = [];
  for (const name of SKILL_NAMES) {
    const s = readSkill(name);
    if (s) out.push(s);
    else console.warn('[skills] missing skills/' + name + '/SKILL.md');
  }
  return out;
}

const SKILLS = loadSkills();

/** The GET /api/skills payload. */
function skillsIndex() {
  return {
    count: SKILLS.length,
    /** Endpoints every skill relies on, so an agent can bootstrap from one call. */
    api: {
      base: '/api',
      auth: 'Authorization: Bearer $FROG_API_TOKEN',
      env: ['FROG_API_BASE', 'FROG_API_TOKEN'],
    },
    skills: SKILLS.map((s) => ({
      name: s.name,
      description: s.description,
      path: s.path,
      url: '/api/skills/' + s.name,
      bytes: s.bytes,
    })),
  };
}

module.exports = { SKILLS, SKILL_NAMES, skillsIndex, loadSkills, parseFrontmatter, SKILLS_DIR };
