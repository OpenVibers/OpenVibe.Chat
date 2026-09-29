'use strict';
/** Which engine a Chat release (a checkout's directory) serves from: PostgreSQL from plan T3 on (migrations/, no better-sqlite3). */
const fs = require('fs');
const path = require('path');

function onPostgres(dir) {
    let deps = {};
    try { deps = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies || {}; } catch { /* */ }
    return !deps['better-sqlite3'] && fs.existsSync(path.join(dir, 'migrations'));
}

module.exports = { onPostgres };
