'use strict';
/**
 * Chat's side of the N-1 harness (test/n-1/harness.js): its clients, how a release boots and is
 * seeded, where its SQL lives. Used by scripts/n-1-record.js (on N-1, in a temporary worktree) and by
 * test/n-1.test.js (on this checkout), so both boot and seed the same way.
 *
 * Chat's clients are its own pages' scripts (public/web, server/web), the openvibe-sdk chat client as
 * that release installed it, the links, scripts and forms of the openvibe.chat pages it served, and
 * OpenVibe.Live's chat widget, messenger, emote and sound pickers: every Live page call that
 * openvibe.live's nginx sends to Chat (/api/chat, /api/dm, /api/tts, /api/sounds) and the /ws/chat
 * messages Live's chat sends. At record
 * time Live's files come from the Live release in production: N1_LIVE_REPO (default ../OpenVibe.Live)
 * at N1_LIVE_REF (default its HEAD); the fixture names that commit.
 *
 * A release boots with its own test/helpers.js (stub Network and Live, Chat in-process) in a child
 * process (test/n-1/boot-child.js), which also seeds it.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { readTree, gitFiles } = require('./harness');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, 'preload.js');
const CHILD = path.join(__dirname, 'boot-child.js');
const CHAT_PATHS = /^\/(api\/(chat|dm|tts)\/|api\/sounds(\/|$))/;
const LIVE_REPO = path.resolve(ROOT, process.env.N1_LIVE_REPO || '../OpenVibe.Live');
// Files are labelled with their checkout's directory name (harness gitFiles), which need not be OpenVibe.Live.
const LIVE_LABEL = `${path.basename(LIVE_REPO)}:`;
let liveRef = null;

function baseEnv(extra) {
    return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '/tmp', NODE_ENV: 'test', ...extra };
}

module.exports = {
    service: 'chat',

    /** Chat's pages and Live's chat surfaces (record time only: Live comes from its repository). */
    clientFiles(dir) {
        liveRef = execFileSync('git', ['-C', LIVE_REPO, 'rev-parse', '--verify', `${process.env.N1_LIVE_REF || 'HEAD'}^{commit}`], { encoding: 'utf8' }).trim();
        return [
            ...readTree(dir, ['public/web', 'server/web', 'node_modules/openvibe-sdk/src/chat.js'], ['.js']),
            ...gitFiles(LIVE_REPO, liveRef, ['public/js', 'public/fragments', 'public/obs', 'public/index.html', 'public/popout-chat.html', 'public/kiosk.html'], ['.js', '.html']),
        ];
    },
    clientReleases: () => ({ live: liveRef }),
    callers: [
        { name: 'api', prefix: '/api' },
        { name: 'apiSWR', prefix: '/api' },
        { name: 'dmApi', prefix: '/api/dm' },
        { name: 'fetch' },
        { name: 'navigator.sendBeacon', method: 'POST' },
        { name: 'call', object: true },
    ],
    strip: ['API', 'location.origin', 'window.location.origin'],
    /** Live's calls to the paths nginx sends to Chat; everything Chat's own pages call or link to. */
    keep: (pathname, method, file) => !String(file || '').startsWith(LIVE_LABEL) || CHAT_PATHS.test(pathname),
    /** openvibe.chat's pages an open tab may hold (anonymous): their links, scripts and forms are replayed too. */
    crawl: ['/', '/rooms', '/r/n1-room', '/messages', '/settings', '/updates'],
    origins: ['https://openvibe.chat'],
    /** Values for template expressions, first match wins (the ids boot-child.js seeds). */
    samples: [
        [/stream/i, '500'],
        [/room/i, 'n1-room'],
        [/conv/i, '1'],
        [/message_?id|dataset\.id/i, '1'],
        [/channel_?user_?id|chatChannelUserId/i, '1001'],
        [/\.id\)*$|uid\)*$|user_?id\)*$/i, '1002'],
        [/after|before|latest|newest|oldest|cursor/i, '0'],
        [/user_?name/i, 'n1fan'],
        [/provider/i, 'tenor'],
        [/kind/i, 'follow'],
        [/^q$|query/i, 'n1'],
    ],
    ws: {
        path: '/ws/chat?stream=500',
        // The chat sockets' clients (Live's other pages open /ws/broadcast, /ws/control and /ws/call).
        files: (name) => /(public\/js\/chat\.js|popout-chat\.html|obs\/chat\.html|public\/web\/chat\.js)$/.test(name),
        headers: { origin: 'https://openvibe.live', 'cf-connecting-ip': '203.0.113.10' },
        order: ['join', 'join_stream', 'get-users', 'chat', 'join_room', 'room_message', 'leave_room', 'leave_stream', 'self-delete-history'],
        // Messages that tick on a clock rather than answer the client.
        ignore: [],
    },

    sqlDirs: ['server'],
    ledgerTables: ['chat_meta'],

    /** Chat migrates when it boots (server/index.js start → initDb); nothing to do first. */
    seed() {},

    /** Boots the release in `dir` on dbPath → { url, headers(auth), wsValues(auth), close() }. */
    async boot({ dir, dbPath, sqlOut = '' }) {
        const child = spawn(process.execPath, ['-r', PRELOAD, CHILD], {
            cwd: dir,
            env: baseEnv({ N1_DB: dbPath, N1_SQL_OUT: sqlOut }),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let log = '';
        let info = null;
        const ready = new Promise((resolve, reject) => {
            child.stdout.on('data', (c) => {
                log = (log + c).slice(-20000);
                const line = String(c).split('\n').find((l) => l.startsWith('{"n1":'));
                if (line && !info) { info = JSON.parse(line).n1; resolve(); }
            });
            child.on('exit', () => reject(new Error(`the release in ${dir} exited while booting:\n${log.slice(-3000)}`)));
        });
        child.stderr.on('data', (c) => { log = (log + c).slice(-20000); });
        const exited = new Promise((resolve) => child.on('exit', resolve));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
        await ready;
        clearTimeout(timer);
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        return {
            url: info.url,
            ids: info.ids,
            log: () => log,
            headers: (auth) => (auth === 'user' ? { authorization: `Bearer ${info.token}` } : {}),
            wsValues: (auth) => ({
                streamId: info.ids.stream, channelUserId: info.ids.star, room: info.ids.room || 'n1-room',
                message: 'hello from the N-1 client', token: auth === 'user' ? info.token : undefined,
            }),
            async close() {
                if (child.exitCode == null) child.kill('SIGTERM');
                const t = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 8000);
                await exited;
                clearTimeout(t);
            },
        };
    },
};
