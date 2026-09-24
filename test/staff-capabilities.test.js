'use strict';
/** Chat's staff gates ask the openvibe-contracts staff map (ADR-022); no server file compares an actor's role by hand. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { staff } = require('openvibe-contracts');
const p = require('../server/auth/permissions');

const people = { user: { id: 1, role: 'user' }, global_mod: { id: 2, role: 'global_mod' }, admin: { id: 3, role: 'admin' }, owner: { id: 4, role: 'admin', is_owner: 1 } };
for (const [name, u] of Object.entries(people)) {
    const map = new Set(staff.capabilitiesOf({ role: u.role, is_owner: !!u.is_owner }));
    for (const cap of staff.map.capabilities.map((c) => c.id)) assert.strictEqual(p.can(u, cap), map.has(cap), `${name} ${cap}`);
    assert.strictEqual(p.canViewOtherUserLogs(u), map.has('staff.moderation.logs'), `${name} logs`);
}
assert.strictEqual(p.can(null, 'staff.moderation.chat'), false);
assert.strictEqual(p.can({ id: 5, role: 'user', staff_caps: ['staff.moderation.bypass'] }, 'staff.moderation.bypass'), true, 'issued claims win');
assert.throws(() => p.can(people.admin, 'staff.nope'), /unknown staff capability/);

const TARGET_RANK = [['chat/chat-server.js', "targetUser.role === 'admin'"]];
const offenders = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { walk(f); continue; }
        if (!e.name.endsWith('.js')) continue;
        const rel = path.relative(path.join(__dirname, '..', 'server'), f).split(path.sep).join('/');
        if (rel === 'auth/permissions.js') continue;
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (/role\s*[!=]==?\s*'(admin|global_mod)'/.test(line) && !TARGET_RANK.some(([file, snip]) => file === rel && line.includes(snip))) offenders.push(`server/${rel}:${i + 1}`);
        });
    }
})(path.join(__dirname, '..', 'server'));
assert.deepStrictEqual(offenders, [], 'raw role checks; use permissions.can(user, \'staff.…\')');
console.log('staff capabilities: all checks passed');
