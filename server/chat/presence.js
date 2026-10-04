'use strict';

async function snapshot(chatServer) {
    const streams = {};
    const users = [];
    const anons = [];
    for (const [, c] of chatServer.clients) {
        if (c.streamId) streams[c.streamId] = null;
        if (c.user) users.push({ user_id: c.user.id, ip: c.ip, stream_id: c.streamId || null });
        else if (c.anonId) anons.push({ anon_id: c.anonId, ip: c.ip, stream_id: c.streamId || null });
    }
    for (const sid of Object.keys(streams)) streams[sid] = chatServer.getStreamViewerCount(Number(sid));
    return {
        at: new Date().toISOString(),
        total: chatServer.getTotalConnections(),
        streams,
        slow_mode: Object.fromEntries(await chatServer.slowModeByStream()),
        users,
        anons,
    };
}

module.exports = { snapshot };
