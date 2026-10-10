'use strict';
/** PostgreSQL is the serving store; completed SQLite tooling and file settings are gone. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./helpers');

const t = suite('no-sqlite');
const ROOT = path.join(__dirname, '..');
const at = (name) => path.join(ROOT, name);
const source = (name) => fs.readFileSync(at(name), 'utf8');

function files(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? files(file) : [file];
    });
}

t('package dependencies use PostgreSQL and do not include SQLite drivers', () => {
    const pkg = JSON.parse(source('package.json'));
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const name of ['better-sqlite3', 'sqlite3']) assert.ok(!(pkg[group] || {})[name], `${group} lists ${name}`);
    }
    assert.ok(pkg.dependencies.pg && pkg.dependencies['openvibe-sdk']);
    assert.ok(pkg.devDependencies['@electric-sql/pglite']);
    assert.ok(!pkg.scripts['import-from-live']);
});

t('removed tools, tests, and runbooks are absent', () => {
    for (const name of [
        'scripts/import-from-live.js', 'scripts/import-sqlite-to-pg.js', 'scripts/migrate-chat-preferences.js',
        'scripts/parity-check.js', 'scripts/lib/sqlite.js', 'server/prefs/from-live.js',
        'test/import.test.js', 'test/import-pg.test.js', 'test/migrate-preferences.test.js',
        'test/rehearsal.test.js', 'test/cutover-evidence.test.js', 'docs/cutover.md',
        'docs/cutover-evidence-t3.md', 'docs/pg-port',
    ]) assert.ok(!fs.existsSync(at(name)), `${name} still exists`);
});

t('service and configuration do not open SQLite files', () => {
    for (const file of files(at('server')).filter((f) => /\.js$/.test(f))) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /require\(['"](?:better-sqlite3|sqlite3|node:sqlite|openvibe-sdk\/sqlite-import|openvibe-sdk\/sqlite-cli)['"]\)/, file);
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\b(?:[A-Z_]*DB_PATH)\b/, file);
    }
    for (const name of ['.env.example', 'deploy/systemd/openvibe-chat.service', 'README.md']) {
        assert.doesNotMatch(source(name), /\b(?:[A-Z_]*DB_PATH)\b/, name);
    }
    for (const file of files(at('scripts')).filter((f) => /\.js$/.test(f))) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /require\(['"](?:better-sqlite3|sqlite3|node:sqlite)['"]\)/, file);
    }
});

t('current docs and deployment files do not refer to retired tools or the Chat file setting', () => {
    const retired = /CHAT_DB_PATH|scripts\/(?:import-from-live|import-sqlite-to-pg|migrate-chat-preferences|parity-check)\.js|docs\/(?:cutover(?:-evidence-t3)?\.md|pg-port\/|live-patch\.diff)/;
    for (const name of ['README.md', 'STATUS.json', '.env.example', 'deploy/systemd/openvibe-chat.service']) {
        assert.doesNotMatch(source(name), retired, name);
    }
    for (const file of files(at('docs'))) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), retired, file);
});

t('production without DATABASE_URL fails before opening PGlite', async () => {
    const { openDb } = require('../server/db/database');
    await assert.rejects(openDb({ db: { url: '' }, nodeEnv: 'production' }), /DATABASE_URL is not set/);
});

t.run();
