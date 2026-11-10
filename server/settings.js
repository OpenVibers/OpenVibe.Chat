'use strict';

/**
 * Owner settings (D11) for OpenVibe.Chat: the voice keys in `chat.voices`, on openvibe-shared/config.
 *
 * The values are read through value() at the moment they are used: a value the owner entered in the
 * admin panel wins, the environment is the fallback, and Live's old `tts_*` site setting is the last
 * fallback so nothing changes until the owner sets one. Secret-class values are sealed by the shared
 * store under OV_CONFIG_KEKS and are write-only through /internal/config/:namespace/secrets/:key;
 * summaries, history and logs carry markers, never a value.
 *
 * Network's admin proxy reaches this namespace with the `chat.config.manage` capability, acting for
 * the owner (X-OV-Subject); a secret or x-danger change needs X-OV-Fresh: 1. The test route asks the
 * provider to synthesize one short line and answers ok or failed in one line, never echoing a key.
 */
const { createConfigStore, adminRoutes } = require('openvibe-shared/config');

const SERVICE = 'chat';
const NAMESPACE = 'chat.voices';
const BASE_PATH = '/internal/config';
const GROUP = 'Voices';

const SECRETS = new Set(['amazon_polly_access_key_id', 'amazon_polly_secret_access_key', 'google_cloud_service_account_json']);

const REGIONS = {
    'us-east-1': { label: 'US East (N. Virginia)', description: 'The default AWS region: lowest latency for most of the network.' },
    'us-west-2': { label: 'US West (Oregon)', description: 'The AWS region on the west coast of the United States.' },
    'eu-west-1': { label: 'Europe (Ireland)', description: 'The AWS region in Ireland, for European voices and people.' },
    'eu-central-1': { label: 'Europe (Frankfurt)', description: 'The AWS region in Frankfurt, Germany.' },
    'ap-northeast-1': { label: 'Asia Pacific (Tokyo)', description: 'The AWS region in Tokyo, Japan.' },
    'ap-southeast-2': { label: 'Asia Pacific (Sydney)', description: 'The AWS region in Sydney, Australia.' },
};

const SCHEMA = Object.freeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Chat settings',
    description: 'Owner controlled Chat features and voice providers.',
    type: 'object',
    additionalProperties: false,
    properties: {
        stage_channels_enabled: {
            type: 'boolean', title: 'Stage channels', 'x-group': 'Channels', default: false,
            description: 'Allow server owners to create stage channels. Stage audio uses Chat voice rooms.',
            'x-required-for': 'Stage channels',
            'x-owner-input': { group: 'voices', unlocks: 'Stage channel controls in Chat servers using existing voice rooms.', get_it_at: 'https://openvibe.chat', get_it_how: 'This is a Chat feature switch. Enable it to let server owners create stage channels.' },
        },
        amazon_polly_access_key_id: {
            type: 'string', title: 'Amazon Polly access key ID', 'x-group': GROUP,
            description: 'The access key ID of an AWS user that may call Polly. Together with its secret it turns on the Polly voices in chat; the ID alone does nothing.',
            'x-owner-input': {
                group: 'voices',
                unlocks: 'The Amazon Polly voices can speak in chat (Joanna, Matthew, the neural and long-form voices).',
                get_it_at: 'https://console.aws.amazon.com/iam/home#/security_credentials',
                get_it_how: 'Open an IAM user that may call Polly, create an access key, and paste the ID and its secret here.',
                test: true,
            },
            'x-required-for': 'Amazon Polly voices',
        },
        amazon_polly_secret_access_key: {
            type: 'string', title: 'Amazon Polly secret access key', 'x-group': GROUP,
            description: 'The secret that goes with the access key ID. Entered here it is locked and never shown again; enter it again if you make a new key in AWS.',
            'x-owner-input': {
                group: 'voices',
                unlocks: 'The Amazon Polly voices can speak; without the secret the access key ID cannot sign a request.',
                get_it_at: 'https://console.aws.amazon.com/iam/home#/security_credentials',
                get_it_how: 'It is shown once when the access key is created. Copy it then; AWS cannot show it again.',
                test: true,
            },
            'x-required-for': 'Amazon Polly voices',
        },
        amazon_polly_region: {
            type: 'string', title: 'Amazon Polly region', 'x-group': GROUP, enum: Object.keys(REGIONS),
            default: 'us-east-1',
            description: 'The AWS region the Polly requests are signed for. Pick the region nearest the people listening; voices are the same everywhere, the latency is not.',
            'x-owner-input': {
                group: 'voices',
                unlocks: 'Amazon Polly requests go to the region you choose instead of the default.',
                get_it_at: 'https://console.aws.amazon.com/polly/home',
                get_it_how: 'The region picker at the top right of the AWS console shows the region ID, such as us-east-1.',
                test: true,
            },
            'x-required-for': 'Amazon Polly voices',
            'x-enum-labels': REGIONS,
        },
        google_cloud_service_account_json: {
            type: 'string', title: 'Google Cloud service account key', 'x-group': GROUP,
            description: 'The JSON key of a Google Cloud service account with the text-to-speech permission. Entered here it is locked; it turns on the Google Cloud voices (Standard, WaveNet, Neural2, Studio and Journey).',
            'x-owner-input': {
                group: 'voices',
                unlocks: 'The Google Cloud voices can speak in chat, including WaveNet, Neural2, Studio and Journey.',
                get_it_at: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
                get_it_how: 'Create a service account, give it the Cloud Text-to-Speech User role, add a JSON key, and paste the downloaded JSON here.',
                test: true,
            },
            'x-required-for': 'Google Cloud voices',
        },
    },
});

const TESTABLE = new Set(Object.keys(SCHEMA.properties));
const TEST_PROVIDER = {
    amazon_polly_access_key_id: 'amazon-polly',
    amazon_polly_secret_access_key: 'amazon-polly',
    amazon_polly_region: 'amazon-polly',
    google_cloud_service_account_json: 'google-cloud',
};

const ACTIVE = { settings: null };

/** One setting at the moment it is used: the owner's value, the env value, then the caller's fallback. */
function value(key, envName, fallback = '', env = process.env) {
    if (ACTIVE.settings) return ACTIVE.settings.value(key, envName, fallback, env);
    const e = envName ? env[envName] : undefined;
    return e !== undefined && e !== null && e !== '' ? e : fallback;
}

/** The settings created by this process (server/index.js), for the TTS engine's read path. */
function current() { return ACTIVE.settings; }

/**
 * The test call for one key: the provider makes one short line of audio with the stored credentials.
 * A provider's answer never includes the credentials; the shared store keeps them out of errors too.
 */
async function defaultProbe(provider, creds) {
    const tts = require('./chat/tts-engine');
    const out = await tts.testSynthesize(provider, creds);
    if (!out || !out.audio) throw new Error('the provider returned no audio');
    return out;
}

function redact(text, secrets) {
    let out = String(text == null ? '' : text);
    for (const secret of secrets) {
        if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
    }
    return out.split(/\s+/).join(' ').slice(0, 180);
}

function oneLine(text) { return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 200); }

/**
 * Create the chat.voices store. `ready` resolves once the store has read its active revision; call it
 * before mounting the routes (server/index.js does). `probes` is for tests only.
 */
function createSettings({ db, env = process.env, log = console, probes = null } = {}) {
    let store = null;
    const ready = createConfigStore({
        db, service: SERVICE, namespace: NAMESPACE, schema: SCHEMA,
        classify: (key) => (SECRETS.has(key) ? 'secret' : 'internal'),
        env, log,
        onActivate: () => { try { require('./chat/tts-engine').invalidateSettingsCache(); } catch { /* not loaded */ } },
    }).then((s) => { store = s; return s; });

    const values = () => (store ? store.get() : {});

    function valueOf(key, envName, fallback = '') {
        const v = values()[key];
        if (v !== undefined && v !== null && v !== '') return v;
        const e = envName ? env[envName] : undefined;
        return e !== undefined && e !== null && e !== '' ? e : fallback;
    }

    const probeFor = (provider) => {
        const p = probes && probes[provider];
        return typeof p === 'function' ? p : (creds) => defaultProbe(provider, creds);
    };

    /** POST /internal/config/chat.voices/test/:key → { ok, detail } (one line, never a value). */
    async function test(key) {
        const provider = TEST_PROVIDER[key];
        if (!provider) return { ok: false, detail: 'That setting has no test.' };
        if (provider === 'amazon-polly') {
            const accessKeyId = valueOf('amazon_polly_access_key_id', 'CHAT_POLLY_ACCESS_KEY_ID');
            const secretAccessKey = valueOf('amazon_polly_secret_access_key', 'CHAT_POLLY_SECRET_ACCESS_KEY');
            const region = valueOf('amazon_polly_region', 'CHAT_POLLY_REGION', 'us-east-1');
            if (!accessKeyId || !secretAccessKey) return { ok: false, detail: 'Amazon Polly is not configured: both the access key ID and its secret are needed.' };
            try {
                await probeFor(provider)({ awsAccessKeyId: accessKeyId, awsSecretAccessKey: secretAccessKey, awsRegion: region });
                return { ok: true, detail: `ok — Amazon Polly synthesized a short line in ${region}.` };
            } catch (err) {
                return { ok: false, detail: `failed — Amazon Polly said: ${redact(err && err.message, [accessKeyId, secretAccessKey])}` };
            }
        }
        const serviceAccount = valueOf('google_cloud_service_account_json', 'CHAT_GOOGLE_SERVICE_ACCOUNT_JSON');
        if (!serviceAccount) return { ok: false, detail: 'Google Cloud is not configured: paste the service account key first.' };
        try {
            await probeFor(provider)({ googleServiceAccount: serviceAccount });
            return { ok: true, detail: 'ok — Google Cloud synthesized a short line.' };
        } catch (err) {
            return { ok: false, detail: `failed — Google Cloud said: ${redact(err && err.message, [serviceAccount])}` };
        }
    }

    /** Mount the admin routes and the test route; `guard` is the service-token capability middleware. */
    function mount(app, { guard, log: appLog = log, also = [] } = {}) {
        if (!store) throw new Error('createSettings: await ready before mount()');
        // The owner's test route is mounted in front of the store's dispatcher: openvibe-shared 4.125.0 gave
        // adminRoutes a test route of its own, and the dispatcher answers it first (it wants an acting subject,
        // this one the service-token capability). 2026-11-07, the openvibe-shared v4.126.0 pin round.
        app.post(`${BASE_PATH}/:namespace/test/:key`, guard, async (req, res) => {
            if (req.params.namespace !== NAMESPACE) return res.status(404).json({ error: 'no such configuration namespace' });
            let key = String(req.params.key || '');
            try { key = decodeURIComponent(key); } catch { /* keep it as it is */ }
            if (!TESTABLE.has(key)) return res.status(404).json({ error: 'no such setting' });
            try {
                const out = await test(key);
                return res.status(200).json({ ok: Boolean(out.ok), detail: oneLine(out.detail) });
            } catch (err) {
                appLog.warn(`[config] ${NAMESPACE}: the test for ${key} failed: ${redact(err && err.message, [])}`);
                return res.status(200).json({ ok: false, detail: 'failed — the test did not finish. The service log has the reason.' });
            }
        });
        // `also`: other namespaces served by the same routes (chat.apps, server/chat-apps/owner-settings.js).
        const routes = mountStores(app, { guard, stores: [store, ...also], log: appLog });
        return routes;
    }

    return { namespace: NAMESPACE, schema: SCHEMA, ready, value: valueOf, get: values, test, mount };
}

/** The admin routes for these stores at /internal/config, guarded; the actor is Network's X-OV-Subject. */
function mountStores(app, { guard, stores, log = console }) {
    const routes = adminRoutes(stores, {
        basePath: BASE_PATH,
        requireAdmin: guard,
        actor: (req) => {
            const id = String(req.get('x-ov-subject') || '').trim();
            return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? { type: 'user', id } : null;
        },
        requireFresh: (req) => String(req.get('x-ov-fresh') || '') === '1',
        log,
    });
    app.use(routes.handle);
    return routes;
}

/** Install the process's settings, so the read path sees the owner's values. */
function activate(settings) { ACTIVE.settings = settings; return settings; }

module.exports = { SERVICE, NAMESPACE, SCHEMA, SECRETS, createSettings, activate, current, value, ownerValue: value, mountStores };
