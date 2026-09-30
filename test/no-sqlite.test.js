'use strict';
/**
 * Chat serves from PostgreSQL only (plan T3, decision 11): better-sqlite3 is not a dependency, and nothing the
 * service loads opens SQLite. Reading a SQLite file is left to the one-time tools under scripts/ (Live's snapshot,
 * the production import), through node:sqlite in scripts/lib/sqlite.js.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./helpers');

const t = suite('no-sqlite');
const ROOT = path.join(__dirname, '..');

function files(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...files(p));
        else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
    }
    return out;
}

t('package.json: better-sqlite3 is neither a dependency nor a dev dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) assert.ok(!(pkg[k] || {})['better-sqlite3'], `${k} lists better-sqlite3`);
    assert.ok(pkg.dependencies.pg && pkg.dependencies['openvibe-sdk'], 'pg and openvibe-sdk serve');
});

t('nothing under server/ requires better-sqlite3 or node:sqlite', () => {
    const offenders = files(path.join(ROOT, 'server'))
        .filter((f) => /require\(\s*['"](better-sqlite3|node:sqlite|sqlite3)['"]\s*\)|from\s+['"](better-sqlite3|node:sqlite)['"]/.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(ROOT, f));
    assert.deepStrictEqual(offenders, []);
});

t('scripts read SQLite only through scripts/lib/sqlite.js', () => {
    const offenders = files(path.join(ROOT, 'scripts'))
        .filter((f) => path.relative(ROOT, f) !== path.join('scripts', 'lib', 'sqlite.js'))
        .filter((f) => /require\(\s*['"](node:sqlite|sqlite3)['"]\s*\)/.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(ROOT, f));
    assert.deepStrictEqual(offenders, []);
});

t.run();
