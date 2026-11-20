'use strict';
/**
 * Guests' chat, capped by the day (2026-11-20; the plan's §V.1 guests, the owner's register #801: "Let guests/anons use
 * OpenVibe.chat … with abuse prevention, severe rate limits, and possibly a global cap"; research guests-and-feed §6.5).
 *
 * A guest (no account) writes in global chat and in stream chats that allow it, as before, and now with:
 *   - 20 messages a UTC day per guest, then "sign in (free) to keep chatting";
 *   - 3 of them with a link;
 *   - 5,000 guest messages a day across Chat, then guest writing rests until tomorrow (a breaker: reading never stops,
 *     and accounts are not touched).
 * A guest is its address here, as Chat names guests (chat-server getAnonIdForConnection). Counts are in memory under
 * keyed hashes (a key made at start, never an address in the clear) and start again with the day, or a restart: caps
 * against floods, not a ledger. Settings: CHAT_GUEST_MESSAGES_PER_DAY, CHAT_GUEST_LINKS_PER_DAY,
 * CHAT_GUEST_MESSAGES_PER_DAY_ALL.
 */
const crypto = require('crypto');

const LINK = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]/i;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };

function createGuestCaps({
    perDay = num(process.env.CHAT_GUEST_MESSAGES_PER_DAY, 20),
    linksPerDay = num(process.env.CHAT_GUEST_LINKS_PER_DAY, 3),
    allPerDay = num(process.env.CHAT_GUEST_MESSAGES_PER_DAY_ALL, 5000),
    now = Date.now,
} = {}) {
    const secret = crypto.randomBytes(32);
    const hash = (s) => crypto.createHmac('sha256', secret).update(String(s)).digest('base64url').slice(0, 22);
    let day = '', guests = new Map(), all = 0;
    const roll = () => {
        const d = new Date(now()).toISOString().slice(0, 10);
        if (d !== day) { day = d; guests = new Map(); all = 0; }
    };

    /** Counts a guest's message, or says why it may not go (the words for the guest). */
    function take(address, text) {
        roll();
        if (all >= allPerDay) return 'Guest chat is resting until tomorrow. Sign in (free) to keep chatting.';
        const k = hash(address || 'unknown');
        const g = guests.get(k) || { n: 0, links: 0 };
        if (g.n >= perDay) return `That was today's ${perDay} guest messages. Sign in (free) to keep chatting.`;
        const linked = LINK.test(String(text || ''));
        if (linked && g.links >= linksPerDay) return `Guests can share ${linksPerDay} links a day. Sign in (free) to share more.`;
        g.n += 1; if (linked) g.links += 1; all += 1;
        guests.set(k, g);
        return null;
    }
    /** What is left today for this guest (null when it was never counted). */
    function left(address) {
        roll();
        const g = guests.get(hash(address || 'unknown'));
        return g ? Math.max(0, perDay - g.n) : null;
    }
    return { take, left, stats: () => { roll(); return { day, guests: guests.size, messages: all }; } };
}

module.exports = { createGuestCaps, LINK };
