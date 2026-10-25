'use strict';
/**
 * An inbox's business hours (server/inbox/inbox.js; inboxes.hours): when its people answer. Outside them the panel says
 * when they are back, a handoff says so too, and Vibe knows the team is away. No hours: always open.
 *
 *   hours = { tz: 'America/Los_Angeles', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }   (days: 0 Sunday … 6)
 *   normalize(input) → hours | null (throws a 422 InboxError-shaped { status, code, message } for a bad one)
 *   state(hours, now) → { open: true } | { open: false, back: 'Monday 9:00 AM' }
 */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

function normalize(input, fail) {
    if (input == null || input === '' || input === false) return null;
    const h = typeof input === 'object' ? input : null;
    if (!h) fail(422, 'inbox.hours', 'Hours are { tz, days, start, end }');
    const tz = String(h.tz || '').trim();
    if (!validTz(tz)) fail(422, 'inbox.hours', 'That time zone is not known (use one like America/New_York)');
    const days = [...new Set((Array.isArray(h.days) ? h.days : String(h.days || '').split(/[\s,]+/)).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!days.length) fail(422, 'inbox.hours', 'Pick at least one day');
    const start = String(h.start || ''), end = String(h.end || '');
    if (!TIME_RE.test(start) || !TIME_RE.test(end) || start >= end) fail(422, 'inbox.hours', 'Hours are a start before an end, like 09:00 to 17:00');
    return { tz, days, start, end };
}

/** Weekday and minutes since midnight now, in the hours' time zone. */
function localNow(tz, now) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
        .formatToParts(now).map((p) => [p.type, p.value]));
    return { day: SHORT[parts.weekday], minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}
const minutesOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
function clock(t) {
    const h = Number(t.slice(0, 2)), m = t.slice(3, 5);
    return `${h % 12 || 12}${m === '00' ? '' : `:${m}`} ${h < 12 ? 'AM' : 'PM'}`;
}

function state(hours, now = new Date()) {
    if (!hours) return { open: true };
    const { day, minutes } = localNow(hours.tz, now);
    const start = minutesOf(hours.start), end = minutesOf(hours.end);
    if (hours.days.includes(day) && minutes >= start && minutes < end) return { open: true };
    // The next opening: later today, else the next open day.
    let back = null;
    if (hours.days.includes(day) && minutes < start) back = `today at ${clock(hours.start)}`;
    for (let i = 1; !back && i <= 7; i++) {
        const d = (day + i) % 7;
        if (hours.days.includes(d)) back = `${i === 1 ? 'tomorrow' : WEEK[d]} at ${clock(hours.start)}`;
    }
    const zone = hours.tz.split('/').pop().replace(/_/g, ' ');
    return { open: false, back: `${back} (${zone} time)` };
}

module.exports = { normalize, state, validTz };
