'use strict';
const express = require('express');
const config = require('../config');
const { requireAuth } = require('../auth/auth');
const serviceAuth = require('../net/service-auth');
const ctx = require('../live-context');
const { validate } = require('openvibe-contracts');
const db = require('../db/database');
const servers = require('../rooms/servers');
const { limits } = require('../net/actor-limits');
const router = express.Router();
const readLimit = limits('chat.slash.commands.read', { minute: 60, hour: 600 });
const writeLimit = limits('chat.slash.commands.register', { minute: 10, hour: 100 });

// Metadata consumed by the composer. Executions continue through Chat's authenticated command
// handler, so moderation commands run with the socket owner's existing rights.
const BUILT_INS = [
    { name:'me', description:'Show an action', options:[{name:'text',description:'The action',type:'string',required:true}] },
    { name:'shrug', description:'Send a shrug', options:[{name:'text',description:'Optional message',type:'string',required:false}] },
    { name:'help', description:'Show available commands', options:[] },
    { name:'mute', description:'Mute a member for five minutes', options:[{name:'user',description:'Member',type:'user',required:true}], permission:'moderate' },
    { name:'timeout', description:'Temporarily mute a member', options:[{name:'user',description:'Member',type:'user',required:true},{name:'seconds',description:'Duration',type:'integer',required:false,choices:['60','300','900']}], permission:'moderate' },
    { name:'nick', description:'Set your server nickname', options:[{name:'name',description:'New nickname',type:'string',required:true}] },
    { name:'poll', description:'Ask a poll in this channel', options:[{name:'question',description:'Question and options separated by |',type:'string',required:true}] },
    { name:'vote', description:'Vote in a poll', options:[{name:'poll',description:'Poll number',type:'integer',required:true},{name:'option',description:'Option number',type:'integer',required:true}] },
    { name:'remind', description:'Remind yourself in this channel', options:[{name:'when',description:'10m, 2h or 1d and a message',type:'string',required:true}] },
];
async function serverFor(req, res) {
    if (!req.query.server) return null;
    const server = await servers.bySlug(req.query.server);
    if (!server || !(await servers.access(server, req.user)).read) { res.status(404).json({ error: 'No such server', code: 'servers.not_found' }); return false; }
    return server;
}
router.get('/', requireAuth, readLimit, async (req,res) => {
    if (!config.slashCommands.enabled) return res.status(404).json({ error:'Not found', code:'commands.disabled' });
    const server = await serverFor(req, res); if (server === false) return;
    const query = String(req.query.q || '').replace(/^\//,'').toLowerCase();
    const access = server && await servers.access(server, req.user);
    const commands = BUILT_INS.filter(c => (!c.permission || (server ? access.moderate : true)) && (!query || c.name.startsWith(query))).map(({permission,...c}) => ({ ...c, source: 'builtin' }));
    if (server) for (const row of await db.all('SELECT name, description, options, source, application_id FROM chat_registered_commands WHERE server_id = ? ORDER BY name', [server.id])) {
        if (!query || row.name.startsWith(query)) commands.push({ name: row.name, description: row.description, options: row.options, source: row.source, application_id: row.application_id });
    }
    res.json({ commands });
});
router.get('/autocomplete', requireAuth, readLimit, async (req,res) => {
    if (!config.slashCommands.enabled) return res.status(404).json({ error:'Not found', code:'commands.disabled' });
    const server = await serverFor(req, res); if (server === false) return;
    const name = String(req.query.command || '').replace(/^\//,'').toLowerCase();
    const command = BUILT_INS.find(c => c.name === name) || (server && await db.get('SELECT options FROM chat_registered_commands WHERE server_id = ? AND name = ?', [server.id, name]));
    const option = command?.options.find(o => o.name === String(req.query.option || ''));
    const query = String(req.query.q || '').toLowerCase();
    if (option?.type === 'user' && server) {
        const rows = await db.all(`SELECT u.username FROM chat_server_members m JOIN ctx_users u ON u.id = m.user_id WHERE m.server_id = ? AND m.role != 'blocked' AND lower(u.username) LIKE ? ORDER BY u.username LIMIT 25`, [server.id, `${query.slice(0, 30)}%`]);
        return res.json({ choices: rows.map((r) => r.username) });
    }
    res.json({ choices: (option?.choices || []).filter(c => c.toLowerCase().includes(query)).slice(0,25) });
});
const internalRouter = express.Router();
// Command registration is server configuration. Use the released config grant until
// the dedicated command grant in the next Contracts release is available to Chat.
internalRouter.post('/', serviceAuth.guard('chat.config.manage', { allowPublic: true }), writeLimit, async (req, res) => {
    if (!config.slashCommands.enabled) return res.status(404).json({ error:'Not found', code:'commands.disabled' });
    const principal = req.principal, user = principal.person && await ctx.getUserBySubject(principal.person);
    if (!user || user.is_banned || !/^(app|agent):/.test(principal.sub)) return res.status(403).json({ error:'A person and an approved app or agent grant are required', code:'commands.grant_required' });
    const server = await servers.bySlug(req.body?.server);
    if (!server || !(await servers.access(server, user)).manage) return res.status(403).json({ error:'Only server managers register commands', code:'commands.forbidden' });
    const command = req.body?.command || {}, name = String(command.name || '').toLowerCase(), options = command.options;
    const template = String(req.body?.response_template || '');
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || !validate('chat.command@1', command).valid || BUILT_INS.some((c) => c.name === name) || typeof command.description !== 'string' || command.description.length > 100 || !Array.isArray(options) || options.length > 25 ||
        options.some((o) => !/^[a-z][a-z0-9_-]{0,31}$/.test(o.name) || !['string','integer','boolean','user','channel'].includes(o.type) || typeof o.description !== 'string' || o.description.length > 100 || typeof o.required !== 'boolean') ||
        !template || template.length > 2000) return res.status(422).json({ error:'Invalid command', code:'commands.invalid' });
    try {
        const source = principal.sub.startsWith('agent:') ? 'actor' : 'app';
        await db.run('INSERT INTO chat_registered_commands (server_id, application_id, source, name, description, options, response_template) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)', [server.id, principal.sub, source, name, command.description, JSON.stringify(options), template]);
        res.status(201).json({ command: { name, description: command.description, options, source, application_id: principal.sub } });
    } catch (err) { res.status(409).json({ error:'Command name is already used', code:'commands.name_taken' }); }
});
internalRouter.delete('/:name', serviceAuth.guard('chat.config.manage', { allowPublic: true }), writeLimit, async (req, res) => {
    if (!config.slashCommands.enabled) return res.status(404).json({ error:'Not found', code:'commands.disabled' });
    const principal = req.principal, user = principal.person && await ctx.getUserBySubject(principal.person);
    const server = await servers.bySlug(req.query.server);
    if (!user || user.is_banned || !server || !(await servers.access(server, user)).manage) return res.status(403).json({ error:'Not allowed', code:'commands.forbidden' });
    await db.run('DELETE FROM chat_registered_commands WHERE server_id = ? AND application_id = ? AND name = ?', [server.id, principal.sub, req.params.name]);
    res.json({ ok: true });
});
module.exports = { router, internalRouter, BUILT_INS };
