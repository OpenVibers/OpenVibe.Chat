'use strict';
/**
 * Agent Streams S2 — an agent stream's Chat room for public and unlisted viewers.
 *
 * The room stays private in storage; the link-gated agent API follows Live on every read and post.
 * An unlisted link works until it is rotated, a public stream opens without one, and making the
 * stream private closes both. The S5 suite covers the digest and the polls; this file keeps the
 * S2 room checks running on their own.
 */
const assert = require('assert');
const crypto = require('node:crypto');
const { ids } = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('agent-room-s2');
let h, ann;

t('an unlisted agent room follows its link and a public one opens', async () => {
    h = await boot();
    ann = h.addUser('ann', { subject: ids.newId('user') });
    await h.ctx.upsertUser(h.live.users.get(ann.id));
    h.netModules.subjects.add(ann.subject_id);
    const agentRoom = require('../server/chat/agent-room');
    const view = require('../server/chat/agent-room-view');
    const id = ids.newId('agent_stream');
    const first = 'abcdefghijklmnopqrstuv';
    const second = 'zyxwvutsrqponmlkjihgfe';
    const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
    let liveVisibility = 'unlisted', liveSecret = first;
    view._setAccessCheck(async (_id, key) => liveVisibility === 'public' || (liveVisibility === 'unlisted' && key === liveSecret) ? liveVisibility : null);
    try {
        let hidden = await agentRoom.ensureRoom(`agent:${id}`, { name: 'A private link', subject: ann.subject_id, visibility: 'unlisted', linkSecretHash: hash(first) });
        assert.strictEqual(hidden.visibility, 'private');
        assert.strictEqual(hidden.owner_id, ann.id);
        assert.strictEqual((await h.http('GET', `/api/chat/rooms/${hidden.slug}`)).status, 404);
        assert.strictEqual((await h.http('GET', `/api/chat/agent-rooms/${id}`)).status, 404);
        assert.strictEqual((await h.http('GET', `/api/chat/agent-rooms/${id}?k=${first}`)).status, 200);
        assert.strictEqual((await h.http('GET', `/embed/agent/${id}?k=${first}`)).status, 200);
        const line = await h.http('POST', `/api/chat/agent-rooms/${id}/messages?k=${first}`, { token: ann.token, body: { message: 'The checkout looks good.' } });
        assert.strictEqual(line.status, 201, line.text);
        assert.strictEqual((await h.http('GET', `/api/chat/agent-rooms/${id}/messages?k=${first}`)).body.messages.at(-1).message, 'The checkout looks good.');
        hidden = await agentRoom.ensureRoom(`agent:${id}`, { subject: ann.subject_id, visibility: 'unlisted', linkSecretHash: hash(second) });
        liveSecret = second;
        assert.strictEqual((await h.http('GET', `/api/chat/agent-rooms/${id}?k=${first}`)).status, 404);
        assert.strictEqual((await h.http('GET', `/api/chat/agent-rooms/${id}?k=${second}`)).status, 200);
        await agentRoom.ensureRoom(`agent:${id}`, { subject: ann.subject_id, visibility: 'public' });
        liveVisibility = 'public';
        assert.strictEqual((await h.http('GET', `/api/chat/rooms/${hidden.slug}`)).status, 404, 'the storage room stays private during visibility changes');
        assert.strictEqual((await h.http('GET', `/api/chat/agent-rooms/${id}`)).status, 200);
        liveVisibility = 'private';
        assert.strictEqual((await h.http('GET', `/api/chat/agent-rooms/${id}`)).status, 404);
    } finally { view._setAccessCheck(null); }
});

t('done', async () => {
    await h.shutdown();
    console.log('agent room S2: the unlisted link, posting, rotation and public visibility');
});

t.run();
