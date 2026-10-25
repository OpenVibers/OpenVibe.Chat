'use strict';
/**
 * The front page's real activity (openvibe.chat /): what Chat's own tables say happened, read once a minute and shared
 * by every visitor. Nothing here is made up and nothing is about one reader: counts of chat messages this week and the
 * people who wrote them, every message ever kept, the stream chats on OpenVibe.Live that were busiest this week (the
 * live ones first), and the public servers and rooms. A part that is empty is left out of the page.
 *
 * Only chat lines count (no system lines, commands, tips or sounds), never deleted or filtered ones, and never the
 * channel of a banned account. A person is counted once per week, by account or by anonymous id.
 *
 *   activity() → { weekMessages, weekPeople, totalMessages, streams: [...], rooms: [...], servers: [...] }
 *   sections({ activity, signedIn, live }) → the HTML pieces the page places around global chat
 */
const db = require('../db/database');
const { esc } = require('./layout');

const TTL_MS = 60_000;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const STREAMS_MAX = 8;
const USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;

const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const n = (v) => Number(v || 0).toLocaleString('en-US');
const plural = (v, one, many) => `${n(v)} ${Number(v) === 1 ? one : many}`;

/** "3 hours ago" for a 'YYYY-MM-DD HH:MM:SS' UTC time. */
function ago(ts) {
    const t = Date.parse(/[TZ]/.test(String(ts)) ? String(ts) : `${String(ts).replace(' ', 'T')}Z`);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
    if (s < 86400) { const h = Math.floor(s / 3600); return `${h} hour${h === 1 ? '' : 's'} ago`; }
    const d = Math.floor(s / 86400);
    return `${d} day${d === 1 ? '' : 's'} ago`;
}

let cached = null;   // { at, value }
let running = null;

async function read() {
    const since = sqlTime(Date.now() - WEEK_MS);
    const chatLine = "m.message_type = 'chat' AND COALESCE(m.is_deleted, 0) = 0 AND COALESCE(m.is_filtered, 0) = 0";
    const week = await db.get(`SELECT COUNT(*) AS messages, COUNT(DISTINCT COALESCE(CAST(m.user_id AS text), m.anon_id)) AS people
        FROM chat_messages m WHERE m.timestamp >= ? AND ${chatLine}`, [since]) || {};
    const total = await db.get(`SELECT COUNT(*) AS n FROM chat_messages m WHERE ${chatLine}`) || {};
    // The stream chats on Live that people wrote in this week, by the channel's owner (channel_user_id).
    const busy = await db.all(`SELECT u.username, u.display_name, COUNT(*) AS messages,
            COUNT(DISTINCT COALESCE(CAST(m.user_id AS text), m.anon_id)) AS people, MAX(m.timestamp) AS last
        FROM chat_messages m JOIN ctx_users u ON u.id = m.channel_user_id
        WHERE m.timestamp >= ? AND ${chatLine} AND COALESCE(m.is_global, 0) = 0 AND COALESCE(u.is_banned, 0) = 0
        GROUP BY u.username, u.display_name ORDER BY messages DESC LIMIT ?`, [since, STREAMS_MAX * 2]);
    const live = await db.all(`SELECT u.username, u.display_name, s.title, s.started_at FROM ctx_streams s JOIN ctx_users u ON u.id = s.user_id
        WHERE s.is_live = 1 AND COALESCE(u.is_banned, 0) = 0 ORDER BY s.started_at DESC LIMIT ?`, [STREAMS_MAX]);
    const byName = new Map();
    for (const r of live) {
        if (!USERNAME_RE.test(String(r.username || ''))) continue;
        byName.set(r.username, { username: r.username, display_name: r.display_name || r.username, live: true, title: r.title || null, messages: 0, people: 0, last: null });
    }
    for (const r of busy) {
        if (!USERNAME_RE.test(String(r.username || ''))) continue;
        const row = byName.get(r.username) || { username: r.username, display_name: r.display_name || r.username, live: false, title: null };
        byName.set(r.username, { ...row, messages: Number(r.messages) || 0, people: Number(r.people) || 0, last: r.last || null });
    }
    // Live ones first, then by messages; a quiet channel that is not live (one or two lines) is not a "busy chat".
    const streams = [...byName.values()].filter((s) => s.live || s.messages >= 3)
        .sort((a, b) => (Number(b.live) - Number(a.live)) || (b.messages - a.messages)).slice(0, STREAMS_MAX);
    let rooms = [];
    let servers = [];
    try { rooms = (await require('../rooms/rooms').list(null, { limit: 6 })).public.filter(Boolean); } catch { rooms = []; }
    try { servers = (await require('../rooms/servers').list(null, { limit: 6 })).public.filter(Boolean); } catch { servers = []; }
    return {
        weekMessages: Number(week.messages) || 0, weekPeople: Number(week.people) || 0, totalMessages: Number(total.n) || 0,
        streams, rooms, servers,
    };
}

/** The activity, at most a minute old; a failed read gives the last good one, or an empty one (the parts hide). */
async function activity() {
    if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
    if (!running) {
        running = read().then((value) => { cached = { at: Date.now(), value }; return value; })
            .catch(() => (cached ? cached.value : { weekMessages: 0, weekPeople: 0, totalMessages: 0, streams: [], rooms: [], servers: [] }))
            .finally(() => { running = null; });
    }
    return running;
}

const LIVE = 'https://openvibe.live';

/** Questions and answers, each true of what runs today (the page shows them; the FAQPage JSON-LD repeats them). */
const FAQ = [
    { q: 'Do I need an account to read?', a: 'No. Global chat, public rooms and public servers read without an account. To write, sign in with your free OpenVibe account, the same one every OpenVibe site uses.' },
    { q: 'How do I start a server?', a: 'Sign in, open Servers and give it a name. It starts with text and voice channels; add more, give people roles, and share an invite link. A server can be public or private.' },
    { q: 'What is Vibe?', a: 'OpenVibe\'s own assistant, free with your account: it searches the web and all of OpenVibe, reads pages and pictures you share, remembers what you ask it to, and sets up work that runs every day for you. Your chats with it are private.' },
    { q: 'What are AI members?', a: 'An AI you add to a room or channel, with a name, a persona and a memory of that room. It answers when someone writes its @name, with OpenVibe\'s model or one from your own AI key.' },
    { q: 'Can I send pictures?', a: 'Yes, in rooms and server channels. A picture goes to OpenVibe.Pics as yours, with its hidden location and camera details removed, and shows inline in the conversation.' },
    { q: 'How many people fit in a call?', a: 'Up to eight in a voice or video call, with mute, camera and kick controls. Call one person from your messages, or open a call room.' },
    { q: 'Who can message me?', a: 'You decide in your settings who may start a conversation with you and whether group conversations may add you. You can block anyone from a conversation.' },
];

/** The numbers under the heading: only those that are known and not zero. */
function stats(a) {
    const items = [
        a.weekMessages ? [n(a.weekMessages), 'messages this week'] : null,
        a.weekPeople ? [n(a.weekPeople), a.weekPeople === 1 ? 'person chatting this week' : 'people chatting this week'] : null,
        a.totalMessages ? [n(a.totalMessages), 'messages in all'] : null,
        a.servers.length ? [n(a.servers.length), a.servers.length === 1 ? 'public server' : 'public servers'] : null,
        a.streams.some((s) => s.live) ? [n(a.streams.filter((s) => s.live).length), 'streams live now'] : null,
    ].filter(Boolean);
    if (!items.length) return '';
    return `<dl class="oc-stats">${items.map(([v, l]) => `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}

function streamsSection(a) {
    if (!a.streams.length) return '';
    const item = (s) => `<li><a class="oc-stream" href="${LIVE}/@${esc(s.username)}"><span class="oc-stream-name"><strong>${esc(s.display_name)}</strong>${s.live ? ' <span class="oc-badge oc-badge-live">Live now</span>' : ''}</span>
<span class="oc-muted">${s.live && s.title ? `${esc(s.title)}${s.messages ? ' · ' : ''}` : ''}${s.messages ? `${plural(s.messages, 'message', 'messages')} from ${plural(s.people, 'person', 'people')} this week` : ''}${s.last && !s.live ? ` · last ${esc(ago(s.last))}` : ''}</span></a></li>`;
    return `<section class="oc-home-sec" aria-labelledby="oc-h-streams"><div class="oc-home-head"><h2 id="oc-h-streams">Stream chats on OpenVibe.Live</h2><a href="${LIVE}/">Who is live</a></div>
<p class="oc-muted">Every channel on OpenVibe.Live has its own chat, run by OpenVibe.Chat. The busiest this week:</p>
<ul class="oc-streams" role="list">${a.streams.map(item).join('')}</ul></section>`;
}

function placesSection(a) {
    const servers = a.servers.map((s) => `<li><a class="oc-stream" href="/s/${esc(s.slug)}"><span class="oc-stream-name"><strong>${esc(s.name)}</strong>${s.official ? ' <span class="oc-badge oc-badge-official">official</span>' : ''}</span><span class="oc-muted">${esc(s.description || plural(s.members, 'member', 'members'))}</span></a></li>`);
    const rooms = a.rooms.map((r) => `<li><a class="oc-stream" href="/r/${esc(r.slug)}"><span class="oc-stream-name"><strong>${esc(r.name)}</strong></span><span class="oc-muted">${esc(r.topic || plural(r.members, 'member', 'members'))}${r.last_message_at ? ` · last ${esc(ago(r.last_message_at))}` : ''}</span></a></li>`);
    return [
        servers.length ? `<section class="oc-home-sec" aria-labelledby="oc-h-servers"><div class="oc-home-head"><h2 id="oc-h-servers">Public servers</h2><a href="/servers">All servers</a></div><ul class="oc-streams" role="list">${servers.join('')}</ul></section>` : '',
        rooms.length ? `<section class="oc-home-sec" aria-labelledby="oc-h-rooms"><div class="oc-home-head"><h2 id="oc-h-rooms">Public rooms</h2><a href="/rooms">All rooms</a></div><ul class="oc-streams" role="list">${rooms.join('')}</ul></section>` : '',
    ].join('\n');
}

/** Ask Vibe from the front page: the question opens a new Vibe chat with it in the box (never sent for you). */
function vibeSection() {
    return `<section class="oc-home-sec oc-vibe-card" aria-labelledby="oc-h-vibe"><h2 id="oc-h-vibe">Ask Vibe, OpenVibe's assistant</h2>
<p class="oc-muted">Free with your account. It searches the web and all of OpenVibe, reads the pages and pictures you share, remembers what you ask it to, and sets up work that runs every day for you. Your chats with it are private.</p>
<form class="oc-vibe-ask" action="/vibe" method="get" role="search"><label for="oc-vibe-q" class="oc-sr">Ask Vibe</label><input id="oc-vibe-q" name="ask" type="text" maxlength="1200" placeholder="Ask Vibe anything" autocomplete="off" enterkeyhint="go" required><button type="submit" class="oc-button">Ask</button></form></section>`;
}

function stepsSection() {
    const steps = [
        ['Sign in once', 'Your OpenVibe account works on every OpenVibe site, and your chat settings follow it.'],
        ['Start a server or a room', 'Name it, add text and voice channels, and choose public or invite only.'],
        ['Bring people in', 'Share an invite link, give people roles, add an AI member, or start a call.'],
    ];
    return `<section class="oc-home-sec" aria-labelledby="oc-h-how"><h2 id="oc-h-how">How it works</h2><ol class="oc-steps">${steps.map(([t, d]) => `<li><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('')}</ol></section>`;
}

function faqSection() {
    return `<section class="oc-home-sec" aria-labelledby="oc-h-faq"><h2 id="oc-h-faq">Questions</h2><div class="oc-faq">${FAQ.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div></section>`;
}

function moreSection() {
    const more = [
        [LIVE, 'OpenVibe.Live', 'Go live from your browser, and chat with your viewers.'],
        ['https://openvibe.community', 'OpenVibe.Community', 'Forums and pastes for longer conversations.'],
        ['https://openvibe.pics', 'OpenVibe.Pics', 'Where the pictures you send in chat live.'],
        ['https://openvibe.games', 'OpenVibe.Games', 'Games to play with the people you chat with.'],
    ];
    return `<section class="oc-home-sec" aria-labelledby="oc-h-more"><h2 id="oc-h-more">More on OpenVibe</h2><ul class="oc-more" role="list">${more.map(([href, name, text]) => `<li><a href="${href}/"><strong>${esc(name)}</strong><span>${esc(text)}</span></a></li>`).join('')}</ul></section>`;
}

/** Everything around global chat: the numbers, Ask Vibe, then stream chats, servers and rooms, how it works, questions, more. */
function sections(a) {
    return { stats: stats(a), vibe: vibeSection(), streams: streamsSection(a), places: placesSection(a), steps: stepsSection(), faq: faqSection(), more: moreSection() };
}

module.exports = { activity, sections, FAQ, _reset: () => { cached = null; } };
