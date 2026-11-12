'use strict';
/**
 * Owner settings for Vibe personas (the owner, 2026-11-12: each Vibe chat gets a name and a face made from
 * what it is about, remade when the topic changes, on "the cheapest model possible, but configurable on the
 * admin panel"). They live in the same revisioned configuration as Chat's other owner settings
 * (openvibe-shared/config, namespace chat.persona): the admin page at /admin/persona reads and writes them,
 * and Network's owner settings proxy can read the same namespace.
 *
 * No value here is a secret. The store keeps every revision with its actor, so a change to what Chat may
 * spend on personas is auditable and can be rolled back like the voice keys.
 *
 *   enabled            personas are made at all (default on)
 *   text_model         the catalogue model for names and topic checks; '' = Auto, the cheapest chat model
 *   images             make an avatar picture as well (default off)
 *   image_model        the catalogue model for the avatar; '' = Auto, the cheapest image model
 *   check_every        messages between topic checks (2–100, default 8)
 *   monthly_cap_usd    most Chat may spend on personas in a UTC month; 0 stops persona spending (default 5)
 */
const { createConfigStore } = require('openvibe-shared/config');

const SERVICE = 'chat';
const NAMESPACE = 'chat.persona';

const DEFAULTS = Object.freeze({
    enabled: true,
    text_model: '',
    images: false,
    image_model: '',
    check_every: 8,
    monthly_cap_usd: 5,
});

const SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Vibe personas',
    description: 'The names and faces of Vibe conversations, the models that make them and what they may cost.',
    type: 'object',
    additionalProperties: false,
    properties: {
        enabled: {
            type: 'boolean', title: 'Names and faces for Vibe chats', default: true,
            description: 'Make a name, a glyph and a colour for each Vibe conversation from what it is about; check the topic again every few messages.',
        },
        text_model: {
            type: 'string', title: 'Text model', default: '', maxLength: 200,
            description: 'The Exchange model that names a chat and decides whether its topic changed. Empty means Auto: the cheapest chat model in the catalogue, which is the default and what Chat picks when it is blank.',
        },
        images: {
            type: 'boolean', title: 'Avatar pictures', default: false,
            description: 'Also make a small avatar picture with an image model and store it in OpenVibe.Media. Off by default: it costs more than the name.',
        },
        image_model: {
            type: 'string', title: 'Image model', default: '', maxLength: 200,
            description: 'The Exchange model that draws the avatar. Empty means Auto: the cheapest image model in the catalogue.',
        },
        check_every: {
            type: 'integer', title: 'Messages between topic checks', default: 8, minimum: 2, maximum: 100,
            description: 'How many messages may arrive before Chat asks the cheap model whether the chat has moved to a new topic (2 to 100).',
        },
        monthly_cap_usd: {
            type: 'number', title: 'Monthly spend cap (USD)', default: 5, minimum: 0, maximum: 1000,
            description: 'The most Chat may spend on personas in a UTC month, read from the runs it made. 0 stops persona spending; the page shows what has been spent this month.',
        },
    },
});

let active = null;

function read(store, key) {
    const fallback = DEFAULTS[key];
    let value;
    try { value = store.get(key); } catch { value = undefined; }
    if (value === undefined || value === null) return fallback;
    if (typeof fallback === 'boolean') return value === true || value === 'true' || value === 1 || value === '1';
    if (typeof fallback === 'number') { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
    return String(value);
}

/**
 * Create the store and make it the one the persona engine reads. Resolves once the active revision is
 * loaded; the caller (server/index.js) awaits it before the app mounts /internal/config.
 */
async function createPersonaSettings({ db, log = console } = {}) {
    const store = await createConfigStore({ db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA, log });
    active = store;
    return {
        service: SERVICE,
        namespace: NAMESPACE,
        schema: SCHEMA,
        defaults: DEFAULTS,
        store,
        /** The owner's value, or the default when it is unset or cannot be read. */
        value: (key) => read(store, key),
        get: () => ({ ...DEFAULTS, ...Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, read(store, key)])) }),
        /** The store's revision, for the page's "saved" line. */
        revision: () => (store.revision ? store.revision() : null),
    };
}

/** Installed by createPersonaSettings; null before it has loaded (the engine makes no personas then). */
function current() { return active; }

/** Whether the owner's settings are available at all. No store means no spending. */
function available() { return !!active; }

/** One setting, with the default when the store has not loaded. */
function value(key) { return active ? read(active, key) : DEFAULTS[key]; }

/** Every setting, with defaults. */
function all() { return active ? Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, read(active, key)])) : { ...DEFAULTS }; }

/** For tests: forget the installed store. */
function _reset() { active = null; }

module.exports = {
    SERVICE, NAMESPACE, DEFAULTS, SCHEMA,
    createPersonaSettings, current, available, value, all, _reset,
};
