'use strict';
const express = require('express');
const config = require('../config');
const { requireAuth } = require('../auth/auth');
const { limits } = require('../net/actor-limits');
const router = express.Router();
const readLimit = limits('chat.slash.commands.read', { minute: 60, hour: 600 });

// Metadata consumed by the composer. Executions continue through Chat's authenticated command
// handler, so moderation commands run with the socket owner's existing rights.
const BUILT_INS = [
    { name:'me', description:'Show an action', options:[{name:'text',description:'The action',type:'string',required:true}] },
    { name:'shrug', description:'Send a shrug', options:[{name:'text',description:'Optional message',type:'string',required:false}] },
    { name:'help', description:'Show available commands', options:[] },
    { name:'mute', description:'Mute a member for five minutes', options:[{name:'user',description:'Member',type:'user',required:true}], permission:'moderate' },
    { name:'timeout', description:'Temporarily mute a member', options:[{name:'user',description:'Member',type:'user',required:true},{name:'seconds',description:'Duration',type:'integer',required:false,choices:['60','300','900']}], permission:'moderate' },
];
router.get('/', requireAuth, readLimit, (req,res) => {
    if (!config.slashCommands.enabled) return res.status(404).json({ error:'Not found', code:'commands.disabled' });
    const query = String(req.query.q || '').replace(/^\//,'').toLowerCase();
    const commands = BUILT_INS.filter(c => !query || c.name.startsWith(query)).map(({permission,...c}) => c);
    res.json({ commands });
});
router.get('/autocomplete', requireAuth, readLimit, (req,res) => {
    if (!config.slashCommands.enabled) return res.status(404).json({ error:'Not found', code:'commands.disabled' });
    const name = String(req.query.command || '').replace(/^\//,'').toLowerCase();
    const command = BUILT_INS.find(c => c.name === name);
    const option = command?.options.find(o => o.name === String(req.query.option || ''));
    if (!option?.choices) return res.json({ choices:[] });
    const query = String(req.query.q || '').toLowerCase();
    res.json({ choices:option.choices.filter(c => c.toLowerCase().includes(query)).slice(0,25) });
});
module.exports = { router, BUILT_INS };
