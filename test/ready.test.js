'use strict';
/**
 * /ready tells the truth about Chat's backing store and its Live sync: the database is required
 * (a real read of a chat table; 503 when it fails), the Live sync is optional and reads degraded
 * (still 200) once its last clean pass is older than LIVE_SYNC_STALE_MS — a pass where Live
 * failed does not count as a sync — or when one step has missed its own schedule.
 */
const assert = require('assert');
const { boot, suite } = require('./helpers');

const t = suite('ready');
const STALE_MS = 2500;
let h;

async function ready() {
    const r = await h.http('GET', '/ready');
    return { status: r.status, body: r.body };
}

t('boot', async () => {
    h = await boot({ env: { LIVE_SYNC_STALE_MS: String(STALE_MS) } });
    await h.ctx.sync();
});

t('healthy: 200 ready with a db and a live_sync check', async () => {
    const { status, body } = await ready();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'ready');
    assert.strictEqual(body.ready, true);
    assert.deepStrictEqual(body.failed, []);
    assert.deepStrictEqual(body.degraded, []);
    assert.strictEqual(body.checks.db.status, 'ok');
    assert.strictEqual(body.checks.db.required, true);
    assert.strictEqual(body.checks.live_sync.status, 'ok');
    assert.strictEqual(body.checks.live_sync.required, false);
    assert.strictEqual(body.checks.live_sync.detail.threshold_ms, STALE_MS);
    assert.ok(body.live.last_success_at, 'last successful sync reported');
    assert.strictEqual(body.service, 'chat');
});

t('Live failing: passes keep running but do not count; degraded (still 200) after the threshold', async () => {
    h.live.down = true;
    const failuresBefore = h.ctx.stats.failures;
    await h.sleep(STALE_MS + 1500);
    // Force a pass so the attempt is recorded whatever the 10 s schedule says.
    await h.ctx.sync();
    assert.ok(h.ctx.stats.failures > failuresBefore, 'Live calls failed');
    const { status, body } = await ready();
    assert.strictEqual(status, 200, 'Live is optional: still ready');
    assert.strictEqual(body.status, 'degraded');
    assert.deepStrictEqual(body.degraded, ['live_sync']);
    assert.strictEqual(body.checks.live_sync.status, 'fail');
    assert.match(body.checks.live_sync.error, /last successful Live sync \d+s ago/);
    assert.ok(Date.parse(body.live.last_sync_at) > Date.parse(body.live.last_success_at), 'an attempt is not a success');
});

t('Live back: one clean pass makes it ready again', async () => {
    h.live.down = false;
    await h.ctx.sync();
    const { status, body } = await ready();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'ready');
    assert.strictEqual(body.live.last_sync_at, body.live.last_success_at);
});

t('a step that misses its own schedule is late on its own (not masked by the fast steps)', async () => {
    // 12 s from now the 10 s steps are past interval + 1 s; the 30 s and slower ones are not.
    const s = h.ctx.syncStatus(1000, Date.now() + 12_000);
    assert.ok(s.late_steps.includes('bans') && s.late_steps.includes('streams~'), JSON.stringify(s));
    assert.ok(!s.late_steps.includes('users+') && !s.late_steps.includes('users*'), JSON.stringify(s));
    assert.deepStrictEqual(h.ctx.syncStatus(1000).late_steps, []);
});

t('database failing: 503 not_ready naming the db check', async () => {
    h.db.run('ALTER TABLE chat_messages RENAME TO chat_messages_away');
    try {
        const { status, body } = await ready();
        assert.strictEqual(status, 503);
        assert.strictEqual(body.ready, false);
        assert.strictEqual(body.status, 'not_ready');
        assert.deepStrictEqual(body.failed, ['db']);
        assert.strictEqual(body.checks.db.status, 'fail');
        assert.match(body.checks.db.error, /no such table/);
    } finally {
        h.db.run('ALTER TABLE chat_messages_away RENAME TO chat_messages');
    }
    const { status } = await ready();
    assert.strictEqual(status, 200);
});

t.run(() => h && h.close());
