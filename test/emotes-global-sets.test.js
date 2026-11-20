'use strict';
// Third-party global emote sets never hold an answer (2026-11-20: FrankerFaceZ's API stopped answering this host and
// every /api/emotes/all waited out its 8 s timeout, so every chat's history appeared 8 s late). With stand-in providers:
//   - a provider that never answers: the first ask waits at most 1.5 s and gets none; asks while it is still fetching
//     answer at once; once it has failed, it is not asked again for ten minutes;
//   - a provider that answers: the first ask gets its set; later asks come from the cache, no fetch;
//   - an old set is served at once and fetched again behind the answer.
//   node test/emotes-global-sets.test.js
const assert = require('assert');
const routes = require('../server/chat/emotes-routes');

(async () => {
    const asked = [];
    let ffzFail = null;
    routes._fetchJSON = (url) => {
        asked.push(url);
        if (/frankerfacez/.test(url)) return new Promise((_, reject) => { ffzFail = () => reject(new Error('timeout')); });
        if (/betterttv/.test(url)) return Promise.resolve([{ id: 'b1', code: 'catJAM', imageType: 'gif' }]);
        return Promise.resolve({ emotes: [] });
    };
    routes._resetGlobalSets();

    let t = Date.now();
    assert.deepStrictEqual(await routes._globalSet('ffz'), [], 'a provider that does not answer: none');
    const waited = Date.now() - t;
    assert.ok(waited >= 1400 && waited < 2500, `the first ask waits at most ~1.5 s (${waited} ms)`);
    t = Date.now();
    assert.deepStrictEqual(await routes._globalSet('ffz'), []);
    assert.ok(Date.now() - t < 100, 'while it is still fetching, the next ask answers at once');
    assert.strictEqual(asked.filter((u) => /frankerfacez/.test(u)).length, 1, 'one fetch at a time');
    ffzFail();
    await new Promise((r) => setTimeout(r, 10));
    t = Date.now();
    assert.deepStrictEqual(await routes._globalSet('ffz'), []);
    assert.ok(Date.now() - t < 100 && asked.filter((u) => /frankerfacez/.test(u)).length === 1, 'failed: not asked again for ten minutes, no wait');

    // Ten minutes on, the failed provider is tried again behind the answer: nobody waits for it.
    const realNow0 = Date.now;
    Date.now = () => realNow0() + 11 * 60 * 1000;
    t = realNow0();
    assert.deepStrictEqual(await routes._globalSet('ffz'), []);
    assert.ok(realNow0() - t < 100, 'a retry of a provider that failed makes nobody wait');
    assert.strictEqual(asked.filter((u) => /frankerfacez/.test(u)).length, 2, 'it is asked again');
    Date.now = realNow0;
    ffzFail();
    await new Promise((r) => setTimeout(r, 10));

    const bttv = await routes._globalSet('bttv');
    assert.ok(Array.isArray(bttv) && bttv.length === 1 && bttv[0].code === 'catJAM', JSON.stringify(bttv));
    await routes._globalSet('bttv');
    assert.strictEqual(asked.filter((u) => /betterttv/.test(u)).length, 1, 'cached: no second fetch');

    // An old set: served at once, fetched again behind.
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 3600 * 1000;
    t = realNow();
    const old = await routes._globalSet('bttv');
    assert.ok(old.length === 1 && realNow() - t < 100, 'the old set at once');
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(asked.filter((u) => /betterttv/.test(u)).length, 2, 'and fetched again behind the answer');
    Date.now = realNow;
    console.log('emote sets: never an 8 s wait; one fetch at a time; failures remembered; old sets refreshed behind');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
