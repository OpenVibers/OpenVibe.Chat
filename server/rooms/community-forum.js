'use strict';

/** Forum channels are views over Community's forum API. Chat never stores forum posts or replies. */
const config = require('../config');

class ForumError extends Error {
    constructor(status, message, code = 'forum.unavailable') { super(message); this.status = status; this.code = code; }
}
const slugOf = (v) => {
    const s = String(v || '').trim().toLowerCase();
    return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(s) ? s : null;
};

async function call(method, path, { token = null, body = null } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== null) headers['Content-Type'] = 'application/json';
    let response;
    try {
        response = await fetch(`${config.community.internalUrl}/api/v1/spaces${path}`, {
            method, headers, ...(body !== null ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(config.community.timeoutMs),
        });
    } catch {
        throw new ForumError(503, 'Community forums are unavailable right now');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new ForumError(response.status, data && (data.detail || data.error) || 'Community refused the forum request', data && data.code || 'forum.community_error');
    return data;
}

async function verifyManage(space, token) {
    const slug = slugOf(space);
    if (!slug) throw new ForumError(422, 'Choose a valid Community forum address', 'forum.space_invalid');
    if (!token) throw new ForumError(401, 'Sign in again before connecting a forum', 'forum.sign_in');
    const out = await call('GET', `/${encodeURIComponent(slug)}/threads?limit=1`, { token });
    if (!out || !out.space || out.space.style !== 'forum') throw new ForumError(422, 'That Community space is not a forum', 'forum.not_a_forum');
    if (!out.viewer || !out.viewer.can_moderate) throw new ForumError(403, 'You must moderate that Community forum to connect it', 'forum.not_a_moderator');
    return { slug, space: out.space };
}

async function list(space, token, { sort = 'active', category = '', page = 1, limit = 30 } = {}) {
    const slug = slugOf(space);
    if (!slug) throw new ForumError(404, 'No such forum', 'forum.not_found');
    const q = new URLSearchParams();
    q.set('sort', ['active', 'new'].includes(sort) ? sort : 'active');
    q.set('page', String(Math.max(1, Math.min(1000, Number(page) || 1))));
    q.set('limit', String(Math.max(1, Math.min(50, Number(limit) || 30))));
    if (category) q.set('category', String(category).slice(0, 50));
    return await call('GET', `/${encodeURIComponent(slug)}/threads?${q}`, { token });
}

async function thread(space, slug, token, { page = 1 } = {}) {
    const s = slugOf(space);
    const t = slugOf(slug);
    if (!s || !t) throw new ForumError(404, 'No such forum post', 'forum.not_found');
    return await call('GET', `/${encodeURIComponent(s)}/threads/${encodeURIComponent(t)}?page=${Math.max(1, Number(page) || 1)}`, { token });
}

async function create(space, token, body) {
    const slug = slugOf(space);
    if (!slug) throw new ForumError(404, 'No such forum', 'forum.not_found');
    return await call('POST', `/${encodeURIComponent(slug)}/threads`, { token, body });
}
async function reply(space, threadSlug, token, body) {
    const s = slugOf(space), t = slugOf(threadSlug);
    if (!s || !t) throw new ForumError(404, 'No such forum post', 'forum.not_found');
    return await call('POST', `/${encodeURIComponent(s)}/threads/${encodeURIComponent(t)}/posts`, { token, body });
}
async function moderate(space, threadSlug, token, body) {
    const s = slugOf(space), t = slugOf(threadSlug);
    if (!s || !t) throw new ForumError(404, 'No such forum post', 'forum.not_found');
    return await call('PUT', `/${encodeURIComponent(s)}/threads/${encodeURIComponent(t)}/state`, { token, body });
}
async function categories(space, token) {
    const s = slugOf(space);
    if (!s) throw new ForumError(404, 'No such forum', 'forum.not_found');
    return await call('GET', `/${encodeURIComponent(s)}/categories`, { token });
}

module.exports = { ForumError, slugOf, verifyManage, list, thread, create, reply, moderate, categories };
