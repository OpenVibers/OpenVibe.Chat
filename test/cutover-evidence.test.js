'use strict';
/**
 * The T3 closeout record must exist, keep its checks, and the README must no longer describe the
 * database as SQLite (plan T3; a silent re-draft would lose the evidence). Fails loudly if either regresses.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./helpers');

const t = suite('cutover-evidence');
const ROOT = path.join(__dirname, '..');

t('docs/cutover-evidence-t3.md records the T3 checks', () => {
    const md = fs.readFileSync(path.join(ROOT, 'docs', 'cutover-evidence-t3.md'), 'utf8');
    for (const key of ['health chat', 'DATABASE_URL', 'Import and row parity', 'Valkey ACL', 'Reproduce']) {
        assert.ok(md.includes(key), `docs/cutover-evidence-t3.md is missing "${key}"`);
    }
});

t('README.md no longer describes Chat as SQLite', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(!readme.includes('SQLite today; PostgreSQL per plan T3'), 'README.md still says "SQLite today; PostgreSQL per plan T3"');
});
