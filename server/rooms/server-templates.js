'use strict';
/**
 * The templates a new server starts from, and the categories Explore lists them under (the plan, 2026-11-09,
 * stage V3: "/servers becomes Explore … a template first (Friends, Gaming group, Stream community, Study group,
 * Creators, Blank), each with its channels listed; then a name and a picture; then Public/Private as a segmented
 * control. Done in under 10 seconds.").
 *
 * A template is a name, one line about it and the channels it starts with. Nothing here talks to the database:
 * server/rooms/servers.js creates the channels.
 */

/** The categories Explore filters by. */
const CATEGORIES = ['Gaming', 'Streams', 'Dev', 'Art', 'Music', 'Study', 'AI'];

/** The templates: what a new server starts with. */
const TEMPLATES = [
    {
        id: 'friends',
        name: 'Friends',
        category: 'Study',
        description: 'A small server for a few friends.',
        channels: [
            { name: 'general', kind: 'text' },
            { name: 'plans', kind: 'text' },
            { name: 'lounge', kind: 'voice' },
        ],
    },
    {
        id: 'gaming',
        name: 'Gaming group',
        category: 'Gaming',
        description: 'A team that plays together: a channel per game, and a voice channel to talk in.',
        channels: [
            { name: 'general', kind: 'text' },
            { name: 'looking-for-group', kind: 'text' },
            { name: 'clips', kind: 'text' },
            { name: 'voice', kind: 'voice' },
        ],
    },
    {
        id: 'streams',
        name: 'Stream community',
        category: 'Streams',
        description: 'For a streamer and their people: chat, clips, and a stage to talk from.',
        channels: [
            { name: 'chat', kind: 'text' },
            { name: 'clips', kind: 'text' },
            { name: 'announcements', kind: 'text' },
            { name: 'stage', kind: 'voice' },
        ],
    },
    {
        id: 'study',
        name: 'Study group',
        category: 'Study',
        description: 'A quiet place to learn together: a room per subject and a silent study room.',
        channels: [
            { name: 'general', kind: 'text' },
            { name: 'homework', kind: 'text' },
            { name: 'study-room', kind: 'voice' },
        ],
    },
    {
        id: 'creators',
        name: 'Creators',
        category: 'Art',
        description: 'For people who make things: work in progress, feedback, and a room to show off.',
        channels: [
            { name: 'general', kind: 'text' },
            { name: 'work-in-progress', kind: 'text' },
            { name: 'feedback', kind: 'text' },
            { name: 'lounge', kind: 'voice' },
        ],
    },
    {
        id: 'blank',
        name: 'Blank',
        category: 'Dev',
        description: 'Start empty: one #general, and you add the rest.',
        channels: [{ name: 'general', kind: 'text' }],
    },
];

/** The template with this id, or null. */
const byId = (id) => TEMPLATES.find((t) => t.id === String(id || '')) || null;

/** The category a server may be listed under, or null. */
const category = (name) => (CATEGORIES.includes(String(name || '')) ? String(name) : null);

module.exports = { TEMPLATES, CATEGORIES, byId, category };
