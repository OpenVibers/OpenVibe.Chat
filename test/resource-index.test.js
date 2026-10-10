'use strict';
/** Chat's person-owned authority resource index (ADR-048, plan T13 step 8). */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, suite } = require('./helpers');

const t = suite('resource-index');
let h, token, user, otherUser;
const get = (path, opts = {}) => h.http('GET', `/api/v1/resources${path}`, { token, ...opts });

t('boot and seed rooms', async () => {
    h = await boot();
    token = h.serviceToken(['chat.resource.read']);
    user = h.addUser('index-owner', { subject: contracts.ids.newId('user') });
    otherUser = h.addUser('other-index-owner', { subject: contracts.ids.newId('user') });
    for (const [slug, visibility, archived] of [
        ['index-alpha', 'public', false], ['index-beta', 'private', false],
        ['index-gamma', 'public', false], ['index-archived', 'public', true],
    ]) {
        await h.db.run('INSERT INTO rooms (slug, name, visibility, owner_id, owner_subject, archived_at) VALUES (?, ?, ?, ?, ?, ?)',
            [slug, `Name ${slug}`, visibility, user.id, user.subject_id, archived ? '2026-10-01 00:00:00' : null]);
    }
    for (const slug of ['second-alpha', 'second-beta']) {
        await h.db.run('INSERT INTO rooms (slug, name, visibility, owner_id, owner_subject) VALUES (?, ?, ?, ?, ?)',
            [slug, `Name ${slug}`, 'public', otherUser.id, otherUser.subject_id]);
    }
});

t('page validates and contains only allowed fields', async () => {
    const response = await get('/');
    assert.strictEqual(response.status, 200, response.text);
    const result = contracts.validate('common.resource-list-result@1', response.body);
    assert.ok(result.valid, JSON.stringify(result.errors));
    const rooms = response.body.resources.filter((r) => r.id.startsWith('index-'));
    assert.deepStrictEqual(rooms.map((r) => r.id), ['index-alpha', 'index-beta', 'index-gamma']);
    assert.deepStrictEqual(rooms.map((r) => r.state), ['public', 'private', 'public']);
    for (const room of rooms) {
        assert.deepStrictEqual(Object.keys(room).sort(), ['created_at', 'id', 'kind', 'name', 'owner', 'service', 'state'].sort());
        assert.deepStrictEqual(room.owner, { type: 'user', id: user.subject_id });
        assert.strictEqual(contracts.resources.nameOf(room), null);
        assert.strictEqual(room.kind, 'chat.room');
    }
});

t('limit-one cursor walks each active room exactly once', async () => {
    const expected = (await get('/')).body.resources.map((r) => r.id);
    const seen = [];
    let cursor = null;
    do {
        const response = await get(`/?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        assert.strictEqual(response.status, 200, response.text);
        assert.ok(contracts.validate('common.resource-list-result@1', response.body).valid);
        seen.push(...response.body.resources.map((r) => r.id));
        cursor = response.body.next_cursor;
    } while (cursor);
    assert.deepStrictEqual(seen, expected);
    assert.strictEqual(new Set(seen).size, seen.length);
});

t('owner filters exact subjects and combines with kind and cursor', async () => {
    const owner = encodeURIComponent(user.subject_id);
    const response = await get(`/?owner=${owner}`);
    assert.strictEqual(response.status, 200, response.text);
    const result = contracts.validate('common.resource-list-result@1', response.body);
    assert.ok(result.valid, JSON.stringify(result.errors));
    assert.deepStrictEqual(response.body.resources.map((r) => r.id), ['index-alpha', 'index-beta', 'index-gamma']);
    assert.ok(response.body.resources.every((r) => r.owner.id === user.subject_id));
    assert.deepStrictEqual((await get(`/?owner=${owner}&kind=chat.room`)).body.resources, response.body.resources);
    assert.deepStrictEqual((await get(`/?owner=${owner}&kind=other.kind`)).body.resources, []);
    assert.deepStrictEqual((await get(`/?owner=${owner}&project=prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3`)).body.resources, []);
    assert.deepStrictEqual((await get(`/?owner=${encodeURIComponent(otherUser.subject_id)}`)).body.resources.map((r) => r.id), ['second-alpha', 'second-beta']);
    assert.deepStrictEqual((await get('/?owner=agt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3')).body.resources, []);
    assert.deepStrictEqual((await get('/?owner=')).body.resources, (await get('/')).body.resources);

    const seen = [];
    let cursor = null;
    do {
        const page = await get(`/?owner=${owner}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        assert.strictEqual(page.status, 200, page.text);
        assert.ok(contracts.validate('common.resource-list-result@1', page.body).valid);
        seen.push(...page.body.resources.map((r) => r.id));
        cursor = page.body.next_cursor;
    } while (cursor);
    assert.deepStrictEqual(seen, response.body.resources.map((r) => r.id));
    assert.strictEqual(new Set(seen).size, seen.length);
});

t('project and kind filters, and bad queries', async () => {
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
    assert.deepStrictEqual((await get(`/?project=${project}`)).body.resources, []);
    assert.deepStrictEqual((await get('/?kind=other.kind')).body.resources, []);
    assert.deepStrictEqual((await get('/?kind=chat.room')).body.resources, (await get('/')).body.resources);
    for (const query of ['project=bad', 'owner=svc:live', 'owner=usr_short', 'owner=usr_short&owner=usr_short', 'limit=0', 'limit=1001', 'cursor=bad']) {
        const response = await get(`/?${query}`);
        assert.strictEqual(response.status, 400, response.text);
        assert.strictEqual(response.body.code, 'resources.bad_query');
    }
});

t('service guard rejects missing, user, insufficient, and proxied tokens', async () => {
    const absent = await get('/', { token: null });
    assert.deepStrictEqual([absent.status, absent.body.code], [401, 'token.missing']);
    const person = await get('/', { token: user.token });
    assert.strictEqual(person.status, 401);
    const insufficient = await get('/', { token: h.serviceToken(['chat.message.send']) });
    assert.deepStrictEqual([insufficient.status, insufficient.body.code], [403, 'capability.denied']);
    const proxied = await get('/', { headers: { 'X-Forwarded-For': '203.0.113.4' } });
    assert.deepStrictEqual([proxied.status, proxied.body.code], [403, 'capability.denied']);
});

t('named lookup always returns 404, including names for existing slugs', async () => {
    for (const name of ['ovrn:chat:prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3:room/index-alpha', 'index-alpha', 'missing']) {
        const response = await get(`/${encodeURIComponent(name)}`);
        assert.deepStrictEqual([response.status, response.body.code], [404, 'resources.unknown_resource']);
    }
});

t.run(() => h && h.close());
