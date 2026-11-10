'use strict';

const express = require('express');
const router = express.Router();
const chatAi = require('../ai/chat-ai');

// Global's stable public room identifier. Other rooms are added by the room insight rollout.
router.get('/:id/insight', async (req, res) => {
    if (req.params.id !== 'global') return res.status(404).json({ error: 'Room insight not found' });
    try {
        const insight = await chatAi.getGlobalInsight();
        if (!insight) return res.json({ overview: null, timeline: [], state: 'quiet' });
        const topics = [];
        try {
            const memory = JSON.parse(insight.memory || '{}');
            for (const item of Array.isArray(memory.topics) ? memory.topics : []) {
                const label = typeof item === 'string' ? item : item.label;
                if (label) topics.push({ label: String(label).slice(0, 100), count: Number(item.count) || 0 });
            }
        } catch { /* older summaries store memory as text */ }
        res.json({ overview: { text: insight.overview, topics, people: 0, messages: insight.window_message_count,
            from: null, to: null, updated_at: insight.updated_at },
        timeline: (insight.timeline || []).map((event) => ({ at: event.ts, kind: 'topic', title: event.label,
            text: event.detail || '', message_id: null })), state: 'ready' });
    } catch { res.status(500).json({ error: 'Failed to load room insight' }); }
});

module.exports = router;
