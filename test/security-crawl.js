'use strict';
/**
 * The crawler behind the security suites (roadmap WS-R task 5): lists every route of the booted
 * Chat app (walking Express's router stack, so a route added later is crawled without anyone
 * listing it), fills route parameters with seeded values, and GETs each path as several people,
 * reporting any response whose body or headers carry a value that person must never see.
 * Not a test itself (no .test.js); used with test/helpers.js's boot().
 */

/** The path an Express 4 layer is mounted at ('' for app-level middleware), or null when it is a pattern. */
function mountPath(layer) {
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    let src = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '').replace(/\/\?\(\?=\/\|\$\)$/i, '');
    let i = 0;
    src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${(layer.keys[i++] || {}).name || 'param'}`);
    src = src.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
    return /[\\^$()|[\]*+?]/.test(src) ? null : src;
}

/** Every route of the app behind `server` (an http.Server): [{ path, methods }]. */
function listRoutes(server) {
    const app = server.listeners('request').find((fn) => fn && fn._router);
    if (!app) throw new Error('no Express app on this server');
    const out = [];
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) {
                const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
                for (const p of [].concat(layer.route.path)) if (typeof p === 'string') out.push({ path: prefix + p, methods });
            } else if (layer.handle && Array.isArray(layer.handle.stack)) {
                const mp = mountPath(layer);
                if (mp !== null) walk(layer.handle.stack, prefix + mp);
            } else {
                const mp = mountPath(layer);
                if (mp) out.push({ path: prefix + mp, methods: ['_all'] });
            }
        }
    };
    walk(app._router.stack, '');
    const seen = new Set();
    return out.filter((r) => { const k = `${r.methods.join(',')} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Concrete paths for a template: candidate i of every parameter, for each i (no cross product). */
function expand(template, values) {
    const names = [];
    const t = `/${template.replace(/^\/+/, '')}`.replace(/\*/g, 'x').replace(/:([A-Za-z0-9_]+)\??(\([^)]*\))?/g, (m, n) => { names.push(n); return `:${n}`; });
    if (!names.length) return [t];
    const lists = names.map((n) => values(n));
    const width = Math.max(...lists.map((l) => l.length));
    const paths = new Set();
    for (let i = 0; i < width; i++) {
        let j = 0;
        paths.add(t.replace(/:([A-Za-z0-9_]+)/g, () => { const l = lists[j++]; return encodeURIComponent(String(l[Math.min(i, l.length - 1)])); }));
    }
    return [...paths];
}

/** Every GET path: each GET route expanded, also with `query` appended, plus `extra`. */
function getPaths(server, values, { query = '', extra = [] } = {}) {
    const paths = new Set();
    for (const r of listRoutes(server)) {
        if (!r.methods.includes('get') && !r.methods.includes('_all')) continue;
        for (const p of expand(r.path, values)) {
            paths.add(p);
            if (query && !p.includes('?')) paths.add(`${p}?${query}`);
        }
    }
    for (const p of extra) paths.add(p);
    return [...paths];
}

/** Which of `needles` ({ label: value }) a response carries: [{ label, where }]. */
function leaks(res, needles) {
    const found = [];
    const headerText = [...(res.headers && typeof res.headers.entries === 'function' ? res.headers.entries() : Object.entries(res.headers || {}))].map(([k, v]) => `${k}: ${v}`).join('\n');
    for (const [label, value] of Object.entries(needles)) {
        if (!value) continue;
        if (res.text && res.text.includes(value)) found.push({ label, where: 'body' });
        if (headerText.includes(value)) found.push({ label, where: 'headers' });
    }
    return found;
}

/**
 * GET every path as every person ({ who: { token } }) through h.http. `needlesFor(who)` names what
 * that person must never see. Resolves { found, answered, statuses }.
 */
async function crawl(h, paths, people, needlesFor, { concurrency = 6 } = {}) {
    const found = [];
    const statuses = {};
    let answered = 0;
    let n = 0;
    for (const [who, auth] of Object.entries(people)) {
        const needles = needlesFor(who);
        const ip = `203.0.113.${100 + (n++)}`;   // one address per person: the API limiter counts per address
        const queue = [...paths];
        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (queue.length) {
                const p = queue.shift();
                let r;
                try { r = await h.http('GET', p, { token: auth && auth.token, headers: { 'cf-connecting-ip': ip, 'x-forwarded-for': ip, ...(auth && auth.token ? { cookie: `ov_token=${auth.token}` } : {}) } }); } catch (e) { r = { status: 0, text: '', headers: {} }; }
                if (r.status) answered++;
                const cls = r.status ? `${String(r.status)[0]}xx` : 'none';
                statuses[cls] = (statuses[cls] || 0) + 1;
                for (const l of leaks(r, needles)) found.push(`${who}: GET ${p} → ${r.status} carries ${l.label} in its ${l.where}`);
            }
        }));
    }
    return { found, answered, statuses };
}

/**
 * The crawl reaches routes that call third parties (GIF search, TTS): keep those off the network. Any
 * fetch to a host other than loopback fails the way an unreachable provider does.
 */
function noNetwork() {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
        let host = '';
        try { host = new URL(String((url && url.url) || url)).hostname; } catch { /* */ }
        if (host !== '127.0.0.1' && host !== 'localhost') return Promise.reject(new TypeError('fetch failed (no network in tests)'));
        return realFetch(url, opts);
    };
}

module.exports = { listRoutes, expand, getPaths, leaks, crawl, noNetwork };
