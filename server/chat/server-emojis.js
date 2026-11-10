'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db/database');
const config = require('../config');
const media = require('../media/client');
const servers = require('../rooms/servers');
const { requireAuth } = require('../auth/auth');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 }, fileFilter: (_req, file, cb) => cb(null, ['image/png','image/jpeg','image/gif','image/webp'].includes(file.mimetype)) });
const off = (res) => res.status(404).json({ error: 'Not found', code: 'emoji.disabled' });
const imageType = (b) => b[0] === 0x89 && b.toString('ascii',1,4) === 'PNG' ? 'image/png' : b.toString('ascii',0,4) === 'GIF8' ? 'image/gif' : b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP' ? 'image/webp' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : null;
async function resolve(req, res) {
    const server = await servers.bySlug(req.params.slug);
    if (!server || !(await servers.access(server, req.user || null)).read) { res.status(404).json({ error:'No such server', code:'servers.not_found' }); return null; }
    return server;
}
router.get('/:slug/emojis', async (req,res) => {
    if (!config.emotes.serverEmojiEnabled) return off(res);
    const server = await resolve(req,res); if (!server) return;
    const rows = await db.all('SELECT id, code, media_url FROM emotes WHERE server_id = ? ORDER BY lower(code)', [server.id]);
    res.json({ emojis: rows.map(e => ({ id:e.id, name:e.code, url:e.media_url || null, fallback:`:${e.code}:` })) });
});
router.post('/:slug/emojis', requireAuth, upload.single('file'), async (req,res) => {
    if (!config.emotes.serverEmojiEnabled) return off(res);
    const server = await resolve(req,res); if (!server) return;
    const access = await servers.access(server, req.user);
    if (!access.member) return res.status(403).json({ error:'Join this server first', code:'servers.forbidden' });
    if (!req.file || !imageType(req.file.buffer)) return res.status(400).json({ error:'Upload a PNG, JPEG, GIF or WebP image', code:'emoji.invalid_image' });
    const name = String(req.body.name || '').trim();
    if (!/^[a-z0-9_]{2,32}$/i.test(name)) return res.status(400).json({ error:'Emoji names use 2–32 letters, numbers or underscores', code:'emoji.invalid_name' });
    if (await db.get('SELECT id FROM emotes WHERE server_id = ? AND lower(code) = lower(?)', [server.id,name])) return res.status(409).json({ error:'That name is already used', code:'emoji.name_taken' });
    const count = await db.get('SELECT COUNT(*) AS count FROM emotes WHERE server_id = ?', [server.id]);
    if (Number(count.count) >= 50) return res.status(409).json({ error:'This server has reached its 50 emoji limit', code:'emoji.limit' });
    try {
        const saved = await media.uploadObject(req.file.buffer, { filename:req.file.originalname, mimeType:imageType(req.file.buffer), namespace:'chat' });
        const row = await db.run('INSERT INTO emotes (user_id, code, url, media_url, media_asset_id, server_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', [req.user.id,name,saved.url,saved.url,saved.id,server.id]);
        res.status(201).json({ emoji:{ id:row.rows?.[0]?.id || row.lastInsertRowid, name, url:saved.url, fallback:`:${name}:` } });
    } catch (err) { res.status(500).json({ error:'Could not save emoji', code:'emoji.upload_failed' }); }
});
router.delete('/:slug/emojis/:id', requireAuth, async (req,res) => {
    if (!config.emotes.serverEmojiEnabled) return off(res);
    const server = await resolve(req,res); if (!server) return;
    const access = await servers.access(server, req.user);
    if (!access.moderate) return res.status(403).json({ error:'Only server moderators can remove emoji', code:'emoji.forbidden' });
    const row = await db.get('SELECT id, media_asset_id FROM emotes WHERE id = ? AND server_id = ?', [req.params.id,server.id]);
    if (!row) return res.status(404).json({ error:'Emoji not found', code:'emoji.not_found' });
    await db.run('DELETE FROM emotes WHERE id = ?', [row.id]);
    if (row.media_asset_id) await media.deleteObject(row.media_asset_id);
    res.json({ ok:true });
});
module.exports = router;
