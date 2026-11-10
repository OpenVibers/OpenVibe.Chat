'use strict';
/**
 * OpenVibe's own computer pool for openvibe.party (message 11, 2026-11-08: a party's desktop runs on someone's Link
 * machine or on OpenVibe's compute).
 *
 * A Link machine registered by the owner advertises what it can run (`desktop`, and `browser` for later) and how many
 * desktops it may host at once. A party started with `desktop_hosting: 'openvibe'` asks this pool:
 *
 *   - placement picks a machine with a free desktop, most free first and then the least loaded, never a disabled one;
 *   - the pool holds it for the room (`held`), the machine's Link claims it (`hosting`) and reports its Connect share
 *     (`ready`); the room view says where it runs, plainly;
 *   - when every machine is busy the room waits in line (`queued`) and the view says its position. A released hold
 *     promotes the oldest queued room;
 *   - the room ending releases the hold, and a hold the machine never claimed (or stopped renewing) is released after
 *     the idle window. Link renews by asking for the party's access every three seconds while it hosts;
 *   - pool machines are the owner's own. There is no rental, quote, price or spending path in this module: it only
 *     chooses among machines the owner registered.
 *
 * The owner switch is `party_pool_settings.enabled` (one row, off by default, changed on openvibe.party/pool by an
 * owner session); CHAT_PARTY_POOL=1 is an operator override for a development box. An ordinary person never sees the
 * panel or changes the pool.
 *
 * The registry is an interface, so placement can be tested with a fake:
 *
 *   list() → [{ principal_id, owner_subject, name, can_run, desktops, enabled, last_seen_at }]
 *   get(principal_id) → a machine or null
 *   upsert(fields) / update(principal_id, fields) / remove(principal_id) / touch(principal_id)
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../db/database');

const PRINCIPAL = /^lnk_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const CAN_RUN = new Set(['desktop', 'browser']);
const OPEN_STATES = ['queued', 'held', 'hosting', 'ready'];

class PoolError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new PoolError(status, code, message); };

const settingsOf = () => ({
    enabled: !!config.party.pool.enabled,
    idleMs: Math.max(60_000, Number(config.party.pool.idleMs) || 600_000),
    queueMs: Math.max(60_000, Number(config.party.pool.queueMs) || 1_800_000),
    maxPerActor: Math.max(1, Number(config.party.pool.maxPerActor) || 2),
    maxQueue: Math.max(1, Number(config.party.pool.maxQueue) || 50),
});

const newId = () => `ph_${crypto.randomBytes(12).toString('hex')}`;
const iso = (ms) => new Date(ms).toISOString();

/** A stored machine as the module and its callers use it (jsonb can come back parsed or as text). */
function machineOf(row) {
    if (!row) return null;
    let can = row.can_run;
    if (typeof can === 'string') { try { can = JSON.parse(can); } catch { can = []; } }
    return {
        principal_id: String(row.principal_id || ''),
        owner_subject: String(row.owner_subject || ''),
        name: String(row.name || ''),
        can_run: (Array.isArray(can) ? can : []).filter((x) => CAN_RUN.has(String(x))),
        desktops: Math.max(1, Number(row.desktops) || 1),
        enabled: row.enabled !== false,
        last_seen_at: row.last_seen_at || null,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
    };
}

/** The owner registration fields, checked. → the fields a registry write takes. */
function registrationOf(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(422, 'party.pool_input', 'Send one machine');
    const principal = String(input.principal_id || '');
    if (!PRINCIPAL.test(principal)) fail(422, 'party.pool_principal', 'A pool machine is a Link machine principal (lnk_…)');
    const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    if (!name) fail(422, 'party.pool_name', 'Give the machine a name of 1–80 characters');
    const desktops = Number(input.desktops == null ? 1 : input.desktops);
    if (!Number.isInteger(desktops) || desktops < 1 || desktops > 50) fail(422, 'party.pool_desktops', 'Desktops is a whole number of 1–50');
    const wanted = input.can_run == null ? ['desktop'] : input.can_run;
    const list = Array.isArray(wanted) ? wanted : [wanted];
    const can = [];
    for (const raw of list) {
        const id = String(raw || '');
        if (!CAN_RUN.has(id)) fail(422, 'party.pool_can_run', 'A pool machine can run desktop or browser');
        if (!can.includes(id)) can.push(id);
    }
    if (!can.length) fail(422, 'party.pool_can_run', 'Say what the machine can run');
    if (!can.includes('desktop')) fail(422, 'party.pool_can_run', 'A pool machine for parties runs desktop');
    return { principal_id: principal, name, desktops, can_run: can, enabled: input.enabled !== false };
}

/** The settings row's owner switch, if the owner has used it. → true, false or null (never set). */
function createRegistry({ store = db, now = Date.now } = {}) {
    return {
        async list() {
            return (await store.all('SELECT * FROM party_pool_machines ORDER BY created_at, principal_id')).map(machineOf);
        },
        async get(id) {
            if (!PRINCIPAL.test(String(id || ''))) return null;
            return machineOf(await store.get('SELECT * FROM party_pool_machines WHERE principal_id = ?', [String(id)]));
        },
        async upsert(fields) {
            const at = new Date(now()).toISOString();
            await store.run(`INSERT INTO party_pool_machines (principal_id, owner_subject, name, can_run, desktops, enabled, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (principal_id) DO UPDATE SET owner_subject = excluded.owner_subject, name = excluded.name,
                    can_run = excluded.can_run, desktops = excluded.desktops, enabled = excluded.enabled, updated_at = excluded.updated_at`,
                [fields.principal_id, fields.owner_subject, fields.name, JSON.stringify(fields.can_run), fields.desktops, fields.enabled !== false, at]);
            return await this.get(fields.principal_id);
        },
        async update(id, fields) {
            const cur = await this.get(id);
            if (!cur) return null;
            const next = { ...cur, ...fields, principal_id: cur.principal_id };
            return await this.upsert(next);
        },
        async remove(id) {
            return (await store.run('DELETE FROM party_pool_machines WHERE principal_id = ?', [String(id)])) > 0;
        },
        async touch(id) {
            if (!PRINCIPAL.test(String(id || ''))) return;
            await store.run('UPDATE party_pool_machines SET last_seen_at = now() WHERE principal_id = ?', [String(id)]);
        },
    };
}

function createPool({ registry = createRegistry(), store = db, now = Date.now, log = console } = {}) {
    const cfg = () => settingsOf();

    /** The effective switch: the owner's row, unless the operator set CHAT_PARTY_POOL=1. */
    async function enabled() {
        if (cfg().enabled) return true;
        const row = await store.get('SELECT enabled FROM party_pool_settings WHERE id = 1');
        return !!(row && row.enabled);
    }

    /** The owner flips it; the row is the switch, so every process reads the same answer on its next call. */
    async function setEnabled(on, by = null) {
        await store.run(`INSERT INTO party_pool_settings (id, enabled, updated_at, updated_by) VALUES (1, ?, now(), ?)
            ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, updated_at = now(), updated_by = excluded.updated_by`,
            [!!on, by]);
        return { enabled: await enabled() };
    }

    async function activeHolds() {
        return await store.all(`SELECT * FROM party_pool_holds WHERE state <> 'released'`);
    }

    async function loadByMachine() {
        const rows = await store.all(`SELECT principal_id, COUNT(*) AS n FROM party_pool_holds
            WHERE state IN ('held', 'hosting', 'ready') AND principal_id IS NOT NULL GROUP BY principal_id`);
        const out = new Map();
        for (const row of rows) out.set(String(row.principal_id), Number(row.n) || 0);
        return out;
    }

    /** The machine with the most free desktops, then the least loaded, among enabled machines that can run desktop. */
    function pick(machines, load) {
        const candidates = machines
            .filter((m) => m.enabled && m.can_run.includes('desktop'))
            .map((m) => {
                const used = load.get(m.principal_id) || 0;
                return { machine: m, used, free: m.desktops - used };
            })
            .filter((x) => x.free > 0);
        if (!candidates.length) return null;
        candidates.sort((a, b) =>
            (b.free - a.free) ||
            (a.used / a.machine.desktops - b.used / b.machine.desktops) ||
            a.machine.name.localeCompare(b.machine.name) ||
            a.machine.principal_id.localeCompare(b.machine.principal_id));
        return candidates[0].machine;
    }

    async function queueLength() {
        const row = await store.get("SELECT COUNT(*) AS n FROM party_pool_holds WHERE state = 'queued'");
        return Number(row && row.n) || 0;
    }

    /** A hold's current position in line: 1 is next. */
    async function queuePosition(hold) {
        const row = await store.get(`SELECT COUNT(*) AS n FROM party_pool_holds WHERE state = 'queued'
            AND (created_at < ? OR (created_at = ? AND id < ?))`, [hold.created_at, hold.created_at, hold.id]);
        return (Number(row && row.n) || 0) + 1;
    }

    /**
     * Reserve a machine for a party, or put the party in line. Serialized on the settings row so two people starting
     * at the same moment cannot take the same free desktop.
     * → { queued: false, hold, machine } or { queued: true, hold, position }
     */
    async function place({ actor, slug }) {
        if (!SUBJECT.test(String(actor || ''))) fail(401, 'party.pool_sign_in', 'Sign in to ask for an OpenVibe computer');
        if (!(await enabled())) fail(503, 'party.pool_off', 'OpenVibe computers are not available yet');
        const want = cfg();
        return await store.tx(async () => {
            await store.get('SELECT id FROM party_pool_settings WHERE id = 1 FOR UPDATE');
            const mine = await store.get(`SELECT COUNT(*) AS n FROM party_pool_holds
                WHERE actor_subject = ? AND state <> 'released'`, [actor]);
            if ((Number(mine && mine.n) || 0) >= want.maxPerActor) {
                fail(429, 'party.pool_limit', `You already have ${want.maxPerActor} OpenVibe computer${want.maxPerActor === 1 ? '' : 's'} waiting or running; end one first.`);
            }
            const machines = await registry.list();
            const available = machines.filter((m) => m.enabled && m.can_run.includes('desktop'));
            if (!available.length) fail(503, 'party.pool_empty', 'No OpenVibe computer is registered yet. The owner can add one on the pool panel.');
            const chosen = pick(available, await loadByMachine());
            const id = newId();
            if (chosen) {
                await store.run(`INSERT INTO party_pool_holds (id, slug, room_id, actor_subject, principal_id, state, held_at, renewed_at)
                    VALUES (?, ?, NULL, ?, ?, 'held', ?, ?)`, [id, slug, actor, chosen.principal_id, iso(now()), iso(now())]);
                return { queued: false, hold: await store.get('SELECT * FROM party_pool_holds WHERE id = ?', [id]), machine: chosen };
            }
            if ((await queueLength()) >= want.maxQueue) {
                fail(503, 'party.pool_full', 'Every OpenVibe computer is busy and the line is full right now. Try again in a little while.');
            }
            await store.run(`INSERT INTO party_pool_holds (id, slug, room_id, actor_subject, principal_id, state, renewed_at, created_at)
                VALUES (?, ?, NULL, ?, NULL, 'queued', ?, ?)`, [id, slug, actor, iso(now()), iso(now())]);
            const hold = await store.get('SELECT * FROM party_pool_holds WHERE id = ?', [id]);
            return { queued: true, hold, position: await queuePosition(hold) };
        });
    }

    /** Once the room exists, the hold names it. */
    async function bind(holdId, roomId) {
        await store.run('UPDATE party_pool_holds SET room_id = ? WHERE id = ? AND room_id IS NULL', [roomId, holdId]);
    }

    /** The newest open hold of a room, or null. */
    async function holdForRoom(roomId) {
        if (roomId == null) return null;
        return await store.get(`SELECT * FROM party_pool_holds WHERE room_id = ? AND state <> 'released'
            ORDER BY created_at DESC LIMIT 1`, [roomId]);
    }

    /** The machine's Link is alive: its assignment poll is the pool's presence. */
    async function seen(principal) {
        await registry.touch(principal);
    }

    /** The oldest party waiting for this machine's Link. */
    async function assignmentFor(principal) {
        if (!PRINCIPAL.test(String(principal || ''))) return null;
        return await store.get(`SELECT h.*, r.slug AS party_slug, r.name AS party_title
            FROM party_pool_holds h JOIN rooms r ON r.id = h.room_id
            JOIN room_parties p ON p.room_id = h.room_id
            WHERE h.principal_id = ? AND h.state = 'held' AND p.ended_at IS NULL
              AND p.desktop_state = 'waiting' AND p.desktop_node_id IS NULL
            ORDER BY h.created_at, h.id LIMIT 1`, [principal]);
    }

    /** Link claimed the room's reserved machine. */
    async function claiming(roomId, principal) {
        const row = await store.get(`UPDATE party_pool_holds SET state = 'hosting', renewed_at = ?
            WHERE room_id = ? AND principal_id = ? AND state = 'held' RETURNING *`, [iso(now()), roomId, principal]);
        if (!row) fail(409, 'party.pool_hold', 'This OpenVibe computer is not holding that party');
        return row;
    }

    /** A live hosting Link renewed (its access poll); the idle clock starts over. */
    async function renew(roomId, principal) {
        await store.run(`UPDATE party_pool_holds SET renewed_at = ?
            WHERE room_id = ? AND principal_id = ? AND state IN ('held', 'hosting', 'ready')`, [iso(now()), roomId, principal]);
    }

    /** Link's Connect share is up. */
    async function ready(roomId, principal) {
        await store.run(`UPDATE party_pool_holds SET state = 'ready', renewed_at = ?
            WHERE room_id = ? AND principal_id = ? AND state IN ('held', 'hosting')`, [iso(now()), roomId, principal]);
    }

    /** Release one hold and stop its room's desktop. Idempotent. → the released row or null. */
    async function releaseHold(hold, reason) {
        const row = await store.get(`UPDATE party_pool_holds SET state = 'released', released_at = ?, release_reason = ?
            WHERE id = ? AND state <> 'released' RETURNING *`, [iso(now()), String(reason || 'released').slice(0, 40), hold.id]);
        if (!row) return null;
        if (row.room_id != null) {
            await store.run(`UPDATE room_parties SET desktop_state = 'stopped', desktop_share_url = NULL
                WHERE room_id = ? AND party_kind = 'desktop' AND ended_at IS NULL`, [row.room_id]);
        }
        return row;
    }

    /** A room ended (or its desktop stopped): free its machine. */
    async function releaseRoom(roomId, reason = 'ended') {
        const hold = await holdForRoom(roomId);
        return hold ? releaseHold(hold, reason) : null;
    }

    /** A placement that never became a room (the room insert failed): give the machine or the place in line back. */
    async function cancel(holdId, reason = 'cancelled') {
        const hold = await store.get("SELECT * FROM party_pool_holds WHERE id = ? AND state <> 'released'", [String(holdId || '')]);
        return hold ? releaseHold(hold, reason) : null;
    }

    /** The owner takes a machine out of the pool: its rooms are released and it stops being chosen. */
    async function removeMachine(principal) {
        const holds = await store.all(`SELECT * FROM party_pool_holds
            WHERE principal_id = ? AND state <> 'released'`, [String(principal)]);
        for (const hold of holds) await releaseHold(hold, 'machine_removed');
        return { removed: await registry.remove(String(principal)), released: holds.length };
    }

    /** Where the room runs, or where it waits. → null when the room has no pool hold. */
    async function where(roomId) {
        if (roomId == null) return null;
        // Open holds first; a released one is still the room's "where" line ("released because it went idle").
        const hold = await holdForRoom(roomId)
            || await store.get(`SELECT * FROM party_pool_holds WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [roomId]);
        if (!hold) return null;
        const machine = hold.principal_id ? await registry.get(hold.principal_id) : null;
        const name = machine ? machine.name : 'an OpenVibe computer';
        if (hold.state === 'queued') {
            const position = await queuePosition(hold);
            return { state: 'queued', machine: null, queue_position: position,
                line: `Waiting for an OpenVibe computer: you are ${position === 1 ? 'next' : `${position} in line`}.` };
        }
        if (hold.state === 'held') {
            return { state: 'held', machine: machine ? machine.name : null, queue_position: null,
                line: `${name} is reserved for this party and will start your computer.` };
        }
        if (hold.state === 'hosting') {
            return { state: 'hosting', machine: machine ? machine.name : null, queue_position: null,
                line: `Starting on ${name}, an OpenVibe computer.` };
        }
        if (hold.state === 'ready') {
            return { state: 'ready', machine: machine ? machine.name : null, queue_position: null,
                line: `Running on ${name}, an OpenVibe computer.` };
        }
        return { state: 'released', machine: machine ? machine.name : null, queue_position: null,
            line: hold.release_reason === 'idle'
                ? 'The OpenVibe computer was released because the party went idle.'
                : 'The OpenVibe computer was released.' };
    }

    /** What the start screen needs: whether the pool is on, its size, its free desktops and its line. */
    async function availability() {
        const on = await enabled();
        const machines = on ? (await registry.list()).filter((m) => m.enabled && m.can_run.includes('desktop')) : [];
        let free = 0;
        if (on) {
            const load = await loadByMachine();
            for (const m of machines) free += Math.max(0, m.desktops - (load.get(m.principal_id) || 0));
        }
        return { enabled: on, machines: machines.length, desktops: machines.reduce((n, m) => n + m.desktops, 0),
            free, queued: on ? await queueLength() : 0 };
    }

    /**
     * Release holds that went idle and promote the line. A hold whose machine never claimed it (or stopped renewing)
     * is released after the idle window; a queued room that nobody could seat is released after the queue window.
     * Called every minute by the server and directly by tests.
     */
    async function sweep() {
        const at = now();
        const out = { released: 0, promoted: 0 };
        const want = cfg();
        const idle = await store.all(`SELECT * FROM party_pool_holds
            WHERE state IN ('held', 'hosting', 'ready') AND renewed_at < ?`, [iso(at - want.idleMs)]);
        for (const hold of idle) if (await releaseHold(hold, 'idle')) out.released++;
        const stale = await store.all(`SELECT * FROM party_pool_holds WHERE state = 'queued' AND created_at < ?`,
            [iso(at - want.queueMs)]);
        for (const hold of stale) if (await releaseHold(hold, 'queue_expired')) out.released++;
        // With the owner's switch off nothing new is seated; stale holds above are still released.
        if (!(await enabled())) return out;
        // Oldest first, and only as far as there is room: a later room never jumps ahead in line.
        const waiting = await store.all(`SELECT * FROM party_pool_holds WHERE state = 'queued' ORDER BY created_at, id`);
        if (waiting.length) {
            const machines = (await registry.list()).filter((m) => m.enabled && m.can_run.includes('desktop'));
            const load = await loadByMachine();
            for (const hold of waiting) {
                const chosen = pick(machines, load);
                if (!chosen) break;
                const row = await store.get(`UPDATE party_pool_holds SET state = 'held', principal_id = ?, held_at = ?, renewed_at = ?
                    WHERE id = ? AND state = 'queued' RETURNING *`, [chosen.principal_id, iso(at), iso(at), hold.id]);
                if (!row) continue;
                load.set(chosen.principal_id, (load.get(chosen.principal_id) || 0) + 1);
                out.promoted++;
            }
        }
        if (out.released || out.promoted) log.info?.(`[Party pool] released ${out.released}, seated ${out.promoted}`);
        return out;
    }

    /** The owner panel: the switch, the machines with their load, and every open hold. */
    async function panel() {
        const on = await enabled();
        const machines = await registry.list();
        const load = await loadByMachine();
        const holds = await store.all(`SELECT h.*, r.slug AS party_slug, r.name AS party_title
            FROM party_pool_holds h LEFT JOIN rooms r ON r.id = h.room_id
            WHERE h.state <> 'released' ORDER BY h.created_at, h.id`);
        return {
            enabled: on,
            machines: machines.map((m) => ({
                ...m,
                load: load.get(m.principal_id) || 0,
                free: Math.max(0, m.desktops - (load.get(m.principal_id) || 0)),
            })),
            holds: holds.map((h) => ({
                id: h.id, state: h.state, party: h.party_slug || h.slug, title: h.party_title || null,
                actor: h.actor_subject, machine: h.principal_id || null, queue_position: null,
                created_at: h.created_at, renewed_at: h.renewed_at, release_reason: h.release_reason || null,
            })),
            queued: holds.filter((h) => h.state === 'queued').length,
        };
    }

    // The registry writes the owner panel and its API use (the Link machines live in the registry interface).
    const upsert = (fields) => registry.upsert(fields);
    const update = (principal, fields) => registry.update(principal, fields);

    return { enabled, setEnabled, place, bind, holdForRoom, assignmentFor, seen, claiming, renew, ready, releaseRoom, cancel,
        removeMachine, where, availability, sweep, panel, pick, upsert, update };
}

const registry = createRegistry();
const pool = createPool({ registry });
let timer = null;

/** The server's minute sweep (server/index.js). Off in tests, which call sweep() themselves. */
function start({ intervalMs = 60_000, log = console } = {}) {
    if (timer || config.nodeEnv === 'test') return;
    timer = setInterval(() => { pool.sweep().catch((err) => log.warn?.('[Party pool] sweep failed:', err && err.message)); }, Math.max(15_000, intervalMs));
    if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
    PoolError, PRINCIPAL, CAN_RUN, machineOf, registrationOf, createRegistry, createPool,
    start, stop, ...pool,
};
