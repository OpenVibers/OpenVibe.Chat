'use strict';
const db = require('../db/database');
const rooms = require('./rooms');
const parties = require('./parties');
const clock = require('./sync-clock');

const TRACK_ID = /^rad_[0-9A-HJKMNP-TV-Z]{26}$/;
const LICENCES = new Set(['creator_grant', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'public_domain']);
const base = () => String(process.env.CHAT_RADIO_URL || (process.env.NODE_ENV === 'test' ? '' : 'https://openvibe.download')).replace(/\/+$/, '');
const publicBase = 'https://openvibe.download';
const fail = (status, code, message) => { throw new parties.PartyError(status, code, message); };
const decode = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const trackView = (t) => t && ({ id: t.id, title: t.title, artist: t.artist, source: t.source, source_url: t.source_url,
    licence: t.licence, licence_url: t.licence_url, changes_note: t.changes_note || null, ai_made: !!t.ai_made, audio_url: t.audio_url });

async function catalogue() {
    if (!base()) return [];
    try {
        const response = await fetch(`${base()}/api/v1/radio/tracks`, { redirect: 'error', signal: AbortSignal.timeout(2500) });
        if (!response.ok) return [];
        const body = await response.json();
        return (Array.isArray(body.tracks) ? body.tracks : []).filter((t) => TRACK_ID.test(t.id)
            && t.audio_url === `${publicBase}/api/v1/radio/tracks/${encodeURIComponent(t.id)}/audio`
            && t.title && t.artist && LICENCES.has(t.licence) && /^https:\/\//.test(t.licence_url)).slice(0, 100).map(trackView);
    } catch { return []; }
}

async function track(id) {
    if (!TRACK_ID.test(String(id || ''))) fail(422, 'radio.track', 'Choose an OpenVibe Radio track');
    if (!base()) fail(503, 'radio.unavailable', 'OpenVibe Radio is not configured');
    let response;
    try { response = await fetch(`${base()}/api/v1/radio/tracks/${encodeURIComponent(id)}`, { redirect: 'error', signal: AbortSignal.timeout(2500) }); }
    catch { fail(503, 'radio.unavailable', 'OpenVibe Radio did not answer'); }
    if (!response.ok) fail(422, 'radio.track', 'That track is not published on OpenVibe Radio');
    const value = (await response.json().catch(() => null))?.track;
    const expected = `${publicBase}/api/v1/radio/tracks/${encodeURIComponent(id)}/audio`;
    if (!value || value.id !== id || value.audio_url !== expected || !value.title || !value.artist || !LICENCES.has(value.licence) || !/^https:\/\//.test(value.licence_url) || !['creator', 'creative_commons', 'public_domain', 'ai'].includes(value.source))
        fail(502, 'radio.catalogue', 'OpenVibe Radio returned incomplete track rights');
    return trackView(value);
}

async function start(user, input) {
    const chosen = await track(input.radio_track_id);
    return parties.createMedia(user, { media: chosen.audio_url, source_url: `${publicBase}/radio/tracks/${chosen.id}`,
        title: input.title || `${chosen.title} listening party`, partyKind: 'radio', radioTrack: chosen });
}

async function state(row, party, { user = null, key = null } = {}) {
    if (!row || !party || party.party_kind !== 'radio') return null;
    if (!await parties.mayView(row, party, user, key)) return null;
    const fresh = await db.get('SELECT radio_track, radio_queue, radio_allow_all, radio_version FROM room_parties WHERE room_id = ?', [row.id]);
    return { current: decode(fresh.radio_track), queue: decode(fresh.radio_queue) || [], allow_everyone: !!fresh.radio_allow_all, version: Number(fresh.radio_version) || 0 };
}

async function change(row, party, user, action, input = {}) {
    const access = user ? await rooms.access(row, user) : null;
    if (!access || !access.read) fail(404, 'rooms.not_found', 'No such room');
    if (!party || party.party_kind !== 'radio' || party.ended_at) fail(409, 'radio.party', 'This is not an active listening party');
    const isHost = user.subject_id === party.host_subject;
    const shared = { id: row.id, slug: row.slug };
    for (let tries = 0; tries < 5; tries++) {
        const old = await state(row, party, { user });
        if (!isHost && !old.allow_everyone) fail(403, 'radio.rights', 'Only the host may change the queue');
        const queue = old.queue.slice();
        let current = old.current;
        if (action === 'queue') {
            if (queue.length >= 100) fail(409, 'radio.queue_full', 'The queue is full');
            queue.push(await track(input.track_id));
        } else if (action === 'skip') {
            if (input.expected_id && input.expected_id !== (current && current.id)) return old;
            current = null;
            while (queue.length && !current) {
                const next = queue.shift();
                try { current = await track(next.id); } catch (err) { if (!(err instanceof parties.PartyError) || err.status >= 500) throw err; }
            }
        } else if (action === 'allow') {
            if (!isHost) fail(403, 'radio.rights', 'Only the host changes queue rights');
        } else fail(422, 'radio.action', 'Unknown queue action');
        const allow = action === 'allow' ? input.allow_everyone === true : old.allow_everyone;
        const updated = await db.get(`UPDATE room_parties SET radio_track = ?, radio_queue = ?, radio_allow_all = ?, radio_version = radio_version + 1
            WHERE room_id = ? AND radio_version = ? RETURNING radio_version`, [current ? JSON.stringify(current) : null, JSON.stringify(queue), allow, row.id, old.version]);
        if (!updated) continue;
        if (action === 'skip') {
            const sync = await clock.set(shared, user.subject_id, current
            ? { media: current.audio_url, position_ms: 0, paused: false, rate: 1 }
            : { position_ms: 0, paused: true });
            require('../chat/chat-server').broadcastToRoom(row.id, { type: 'sync', room: row.slug, state: sync });
        }
        const result = { current, queue, allow_everyone: allow, version: Number(updated.radio_version) };
        require('../chat/chat-server').broadcastToRoom(row.id, { type: 'radio', room: row.slug, state: result });
        return result;
    }
    fail(409, 'radio.conflict', 'The queue changed; try again');
}

module.exports = { track, catalogue, start, state, change };
