'use strict';
/**
 * Sound uploads → MP3 through OpenVibe.Tools (platform S9): the `mp3` tool's run API (an audio.process
 * job on the audio satellite) with Chat's service token (tools.tool.run + tools.job.read on
 * openvibe.tools), through openvibe-sdk/tools. The caller keeps its local ffmpeg as the fallback:
 * null here means "convert it yourself" (Tools down, busy, refused, no secret, or CHAT_TOOLS_AUDIO=off).
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('openvibe-sdk/core');
const { createToolsClient } = require('openvibe-sdk/tools');
const serviceAuth = require('../net/service-auth');
const config = require('../config');

const AUDIENCE = 'openvibe.tools';
const TIMEOUT_MS = 45_000;
const MAX_BYTES = 25 * 1024 * 1024;
let tools = null;
const stats = { ok: 0, fallback: 0, last_error: null };

function client() {
    if (tools) return tools;
    const tokenProvider = {
        async getToken() { const h = await serviceAuth.headers(AUDIENCE); return String(h.Authorization || h.authorization || '').replace(/^Bearer\s+/i, ''); },
        invalidate() { serviceAuth.invalidate(AUDIENCE); },
    };
    const base = String(process.env.OV_TOOLS_INTERNAL_URL || 'http://127.0.0.1:4001').replace(/\/+$/, '');
    tools = createToolsClient(createClient({ baseUrls: { tools: base }, tokenProvider, retries: 0 }));
    return tools;
}

/** Transcode to 128 kbps 44.1 kHz stereo MP3 via Tools; the new file's path, or null (use ffmpeg). */
async function convertViaTools(srcPath, { mime = 'application/octet-stream', timeoutMs = TIMEOUT_MS } = {}) {
    if (process.env.CHAT_TOOLS_AUDIO === 'off' || !config.oauth.clientSecret) return null;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
        const data = await fs.promises.readFile(srcPath);
        if (!data.length || data.length > MAX_BYTES) return null;
        const t = client();
        let run = await t.run('mp3', { bitrate: 128, sampleRate: 44100, channels: 2 }, { files: [{ name: path.basename(srcPath), data, type: mime }], waitMs: 30_000, signal });
        if (run.state !== 'succeeded') run = await run.wait({ signal });
        if (!run.job) throw new Error('no job to download from');
        const res = await t.jobs.file(run.job.id, 0, { signal });
        const out = Buffer.from(await res.arrayBuffer());
        if (out.length < 128 || out.length > MAX_BYTES) throw new Error(`result of ${out.length} bytes`);
        const outPath = srcPath.replace(/\.[^.]+$/, '') + '.conv.mp3';
        await fs.promises.writeFile(outPath, out);
        stats.ok++;
        return outPath;
    } catch (err) {
        stats.fallback++;
        stats.last_error = String((err && (err.code || err.message)) || err).slice(0, 200);
        return null;
    }
}

module.exports = { convertViaTools, stats: () => ({ ...stats }), _reset() { tools = null; stats.ok = 0; stats.fallback = 0; stats.last_error = null; } };
