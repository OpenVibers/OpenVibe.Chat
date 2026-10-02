'use strict';
/**
 * Chat's shutdown moved onto openvibe-sdk/service (plan T1 lane A): start() hands the signal to
 * gracefulStop, whose stop steps keep the old hand-written order and whose close step closes the
 * database. The manifest's lifecycle.shutdown.deadlineSeconds is 8 (openvibe-contracts
 * manifests/services/chat.json), so deadlineMs is 8000, and deadlineExitCode 0 keeps the old
 * hard timer's exit code.
 *
 * The first three checks read server/index.js itself (the entry point cannot be inspected through
 * its exports alone); the rest boot Chat with the harness and drive the returned shutdown with
 * process.exit stubbed, so the stop steps can be observed in order and the database close seen.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, suite } = require('./helpers');

const t = suite('service-kit');

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

t('server/index.js imports gracefulStop and within from openvibe-sdk/service', () => {
    const m = src.match(/const\s*\{([^}]*)\}\s*=\s*require\(['"]openvibe-sdk\/service['"]\)/);
    assert.ok(m, "require('openvibe-sdk/service')'s exports are not destructured");
    assert.ok(/\bgracefulStop\b/.test(m[1]), 'gracefulStop is not imported');
    assert.ok(/\bwithin\b/.test(m[1]), 'within is not imported');
});

t('server/index.js leaves the signal handlers to the kit', () => {
    assert.ok(!/process\.on\(\s*['"]SIGTERM['"]/.test(src), 'server/index.js still installs its own SIGTERM handler');
    assert.ok(!/process\.on\(\s*['"]SIGINT['"]/.test(src), 'server/index.js still installs its own SIGINT handler');
    assert.ok(/gracefulStop\(\{/.test(src), 'gracefulStop is not called in start()');
    assert.ok(/name:\s*['"]Chat['"]/.test(src), "gracefulStop is not named 'Chat'");
});

t("the deadline is the manifest's 8 s and the deadline exit code is 0", () => {
    assert.ok(/deadlineMs:\s*8000/.test(src), 'deadlineMs is not 8000');
    assert.ok(/deadlineExitCode:\s*0/.test(src), 'deadlineExitCode is not 0');
    assert.ok(/drainMs:\s*4000/.test(src), 'drainMs is not 4000');
});

let h;

t('boot', async () => {
    h = await boot();
    assert.strictEqual(typeof h.shutdown, 'function', 'start() returned a shutdown handle');
});

t('the returned shutdown runs the stop steps in order and closes the database', async () => {
    const order = [];
    const wrap = (obj, name, tag) => {
        const orig = obj[name].bind(obj);
        obj[name] = (...args) => { order.push(tag); return orig(...args); };
    };
    const chatServer = h.chatServer;
    const callServer = require('../server/calls/call-server');
    const chatAi = require('../server/ai/chat-ai');
    const db = require('../server/db/database');
    wrap(chatServer, 'broadcastAll', 'broadcastAll');
    wrap(h.ctx, 'stop', 'ctx.stop');
    wrap(h.eventsRelay, 'stop', 'relay.stop');
    wrap(h.mirrorRelay, 'stop', 'mirror.stop');
    wrap(h.eventsConsumer, 'stop', 'events.stop');
    wrap(chatAi, 'stop', 'chatAi.stop');
    wrap(h.subscriptions, 'stop', 'subs.stop');
    wrap(h.mirrorRelay, 'flush', 'mirror.flush');
    wrap(chatServer, 'close', 'chatServer.close');
    wrap(callServer, 'close', 'callServer.close');
    wrap(db, 'close', 'db.close');

    const realExit = process.exit;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; };
    let code;
    try {
        code = await h.shutdown();
        assert.strictEqual(exitCode, 0, 'exit() is called with 0');
    } finally {
        process.exit = realExit;
    }
    assert.strictEqual(code, 0, 'the shutdown resolves with exit code 0');

    assert.deepStrictEqual(order, [
        'broadcastAll',
        'ctx.stop',
        'relay.stop',
        'mirror.stop',
        'events.stop',
        'chatAi.stop',
        'subs.stop',
        'mirror.flush',
        'chatServer.close',
        'callServer.close',
        'db.close',
    ], `the stop steps ran in the old order (saw ${order.join(', ')})`);

    // The kit starts the stop once: a second call is the same promise, no step runs again.
    const again = await h.shutdown();
    assert.strictEqual(again, 0, 'a second stop resolves with the same code');
    assert.strictEqual(order.length, 11, 'a second stop runs no step again');
});

// The shutdown step above already stopped the process; detach is a no-op then (and a fallback if a
// check failed before it).
t.run(async () => { try { if (h) await h.detach(); } catch { /* already stopped */ } });
