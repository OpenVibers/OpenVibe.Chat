'use strict';
/**
 * Vibe's one door to the Search Fabric (OpenVibe.Search, plan §4.5): GET /api/v1/query over the
 * network, web and vertical scopes, through `openvibe-sdk/search` (0.70). The fabric returns each
 * result with its URL, provider (open_index/deepseek/wikipedia) and dates, and the web's cites in
 * `citations`.
 *
 *   query({ q, scopes, subject, limit, depth, freshness, signal }) → search.fabric-result@1
 *   isDown(err) → true when the fabric is unreachable, has no such route (404) or fails (5xx): a
 *                 caller may then use its pre-fabric path (Search's /api/v1/search, Actor's web agent)
 *
 * The person is named only when a caller has one and the grant: a first-party service needs
 * search.query.delegate for X-OV-Subject, so web search is asked as Chat for the person (their paid
 * web steps count as theirs). Without Chat's client secret the client is anonymous: the open index
 * and cached web answers still work, but the paid providers do not.
 */
const config = require('../config');

const TIMEOUT_MS = 20000;
const MAX_CITATIONS = 6;
let _client = null;
let _anon = null;
let _tokens = null;

function makeClient(auth) {
    const { createClient } = require('openvibe-sdk');
    const { createSearchClient } = require('openvibe-sdk/search');
    const opts = { timeoutMs: TIMEOUT_MS, retries: 0 };
    if (auth && (config.oauth.clientSecret || _tokens)) {
        const { createServiceTokenClient } = require('openvibe-sdk/auth');
        if (!_tokens) {
            _tokens = createServiceTokenClient({
                tokenUrl: `${config.networkInternalUrl}/oauth/token`,
                clientId: config.oauth.clientId,
                clientSecret: config.oauth.clientSecret,
                audience: 'openvibe.search',
                scope: 'search.query.delegate',
            });
        }
        opts.tokenProvider = _tokens;
    }
    return createSearchClient(createClient(opts), { baseUrl: config.ai.searchUrl });
}

function client() {
    if (!_client) _client = makeClient(true);
    return _client;
}

/** The public index and cached web answers need no token; keep it that way when no person is named. */
function anonymous() {
    if (!_anon) _anon = makeClient(false);
    return _anon;
}

/** An anonymous one-off client around an injected fetch (tests, or a caller with its own transport). */
function clientWith(fetchImpl) {
    const { createClient } = require('openvibe-sdk');
    const { createSearchClient } = require('openvibe-sdk/search');
    return createSearchClient(createClient({ fetch: fetchImpl, timeoutMs: TIMEOUT_MS, retries: 0 }), { baseUrl: config.ai.searchUrl });
}

/** One fabric query. `subject` (usr_/gst_) asks as that person; scopes are the fabric's names; owner/type narrow a retry. */
async function query({ q, scopes = ['network'], subject = null, limit = 8, depth = null, freshness = null, owner = null, type = null, site = null, signal = null } = {}, { client: injected = null, fetchImpl = null } = {}) {
    const body = {
        scopes,
        limit,
        ...(depth ? { depth } : {}),
        ...(freshness ? { freshness } : {}),
        ...(owner ? { owner } : {}),
        ...(type ? { type } : {}),
        ...(site ? { site } : {}),
        ...(subject ? { actingSubject: subject } : {}),
        ...(signal ? { signal } : {}),
    };
    const c = injected || (fetchImpl ? clientWith(fetchImpl) : (subject ? client() : anonymous()));
    return await c.fabric(String(q == null ? '' : q).slice(0, 300), body);
}

/** The fabric is down: a caller may use its old path. A 400/401/403/429 is an answer, not an outage. */
function isDown(err) {
    if (!err) return true;
    const status = Number(err.status);
    if (status === 404 || status === 408 || status >= 500) return true;
    const code = String(err.code || '');
    if (/network|timeout|unavailable|bad_response|econn|enotfound|abort/i.test(code)) return true;
    const message = String(err.message || '');
    if (!Number.isFinite(status) && /network|fetch|unreachable|econn|enotfound|timeout|socket/i.test(message)) return true;
    return err.name === 'AbortError' || err.name === 'TimeoutError';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", apos: "'" };
const text = (v, max) => String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|#39|#x27|apos);/g, (_m, e) => ENTITIES[e]).replace(/\s+/g, ' ').trim().slice(0, max);
const date = (v) => (v ? String(v).slice(0, 40) : null);
const host = (url) => { try { return new URL(String(url)).hostname.replace(/^www\./, '') || null; } catch { return null; } };

/** One result as Vibe sees it: the fabric's citation fields survive (provider and dates are not dropped). */
function resultOf(r, { fallback = false } = {}) {
    const url = String((r && (r.url || r.canonical_url)) || '').slice(0, 2048);
    const snippet = r && (r.snippet || r.summary || (fallback ? r.snippet_html : ''));
    return {
        title: text(r && r.title, 200) || url,
        site: (r && r.site) || (r && r.owner) || host(url),
        type: (r && (r.type || r.kind)) || null,
        summary: text(snippet, 300),
        url,
        provider: (r && r.provider) || null,
        published_at: date(r && r.published_at),
        retrieved_at: date(r && r.retrieved_at),
    };
}

/** The numbered citations Vibe (and its model) can keep: title, URL, provider and both dates. */
function citationsOf(results) {
    return results.filter((r) => /^https?:\/\//i.test(String(r && r.url || ''))).slice(0, MAX_CITATIONS).map((r, i) => ({
        n: i + 1, title: r.title, url: r.url, provider: r.provider || null,
        published_at: r.published_at || null, retrieved_at: r.retrieved_at || null,
    }));
}

function _setClient(c) { _client = c || null; _anon = c || null; }
function _setTokens(t) { _tokens = t || null; _client = null; _anon = null; }
function _reset() { _client = null; _anon = null; _tokens = null; }

module.exports = { query, isDown, resultOf, citationsOf, TIMEOUT_MS, MAX_CITATIONS, _setClient, _setTokens, _reset };
