'use strict';
/** Sound uploads convert through OpenVibe.Tools' mp3 tool with Chat's service token; any failure means null (local ffmpeg). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
    const JOB = 'job_01JAB2C3D4E5F6G7H8J9K0MNPQ';
    const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(400, 7)]);
    let mode = 'ok';
    const seen = [];
    const srv = await new Promise((r) => { const s = http.createServer((req, res) => {
        const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
            const body = Buffer.concat(chunks);
            seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, type: req.headers['content-type'] || '', body });
            const json = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'svc-token', token_type: 'Bearer', expires_in: 300, scope: 'tools.tool.run tools.job.read' });
            if (req.url.startsWith('/api/v1/tools/mp3/run')) {
                if (mode === 'busy') return json(503, { type: 'about:blank', title: 'busy', status: 503, code: 'tools.busy' });
                const job = { object: 'tools.job', id: JOB, state: 'succeeded', result: { files: [{ name: 'a.mp3', mime: 'audio/mpeg', size: MP3.length }], data: {} }, links: { self: `/api/v1/jobs/${JOB}` } };
                return json(200, { state: 'succeeded', tool: 'mp3', result: job.result, took_ms: 5, job });
            }
            if (req.url.startsWith(`/api/v1/jobs/${JOB}/files/0`)) { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(MP3); }
            json(404, { type: 'about:blank', title: 'nope', status: 404 });
        });
    }).listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    process.env.OV_TOOLS_INTERNAL_URL = base;
    process.env.OV_NETWORK_INTERNAL_URL = base;
    process.env.OV_OAUTH_CLIENT_SECRET = 'chat-secret-for-tests-only-0123456789';
    const audio = require('../server/chat/tools-audio');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tools-audio-'));
    const src = path.join(dir, 'boom.wav');
    fs.writeFileSync(src, Buffer.from('RIFF....WAVEfmt fake'));

    const out = await audio.convertViaTools(src, { mime: 'audio/wav' });
    assert.strictEqual(out, path.join(dir, 'boom.conv.mp3'));
    assert.ok(fs.readFileSync(out).equals(MP3), 'the job\'s file is what gets stored');
    const run = seen.find((s) => s.url.startsWith('/api/v1/tools/mp3/run'));
    assert.strictEqual(run.auth, 'Bearer svc-token', 'Chat\'s service token, not anonymous');
    assert.ok(/multipart\/form-data/.test(run.type), 'the upload travels as multipart');
    assert.ok(run.body.includes('"bitrate":128') && run.body.includes('"sampleRate":44100') && run.body.includes('RIFF'), 'input and bytes');
    assert.strictEqual(seen.find((s) => s.url.includes('/files/0')).auth, 'Bearer svc-token');

    mode = 'busy';
    assert.strictEqual(await audio.convertViaTools(src, { mime: 'audio/wav' }), null, 'Tools busy: the caller converts locally');
    process.env.CHAT_TOOLS_AUDIO = 'off';
    mode = 'ok';
    const before = seen.length;
    assert.strictEqual(await audio.convertViaTools(src), null, 'switched off');
    assert.strictEqual(seen.length, before, 'nothing sent while off');
    delete process.env.CHAT_TOOLS_AUDIO;
    srv.close();
    assert.strictEqual(await audio.convertViaTools(src), null, 'Tools down');
    assert.deepStrictEqual([audio.stats().ok, audio.stats().fallback], [1, 2]);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('tools audio: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
