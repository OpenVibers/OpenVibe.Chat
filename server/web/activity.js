'use strict';
/**
 * "What happened" on openvibe.chat/activity: the person's activity feed (server/chat/activity.js) in the same plain
 * list markup the page's other sections use — who, what, where and when, each row opening the place. The page is
 * designed elsewhere; this only supplies the one section, and its look is the shared list's.
 *
 * Opening the page counts as reading it: the rows are taken first (so the newest ones still read as unread on this
 * visit), then the rows shown are marked read and the bottom bar's dot goes away on the next page.
 */
const { esc } = require('./layout');
const ui = require('./ui');
const activity = require('../chat/activity');

const LIMIT = 15;
const REACTION = { thumbsup: '👍', thumbsdown: '👎', heart: '❤️', laugh: '😄', surprised: '😮', sad: '😢' };
const ROLE = { owner: 'owner', admin: 'admin', mod: 'moderator', speaker: 'speaker', participant: 'participant', member: 'member', viewer: 'viewer' };

function excerpt(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const cut = s.length > 90 ? `${s.slice(0, 89)}…` : s;
    return ` <span class="oc-muted">“${esc(cut)}”</span>`;
}

/** One row's "what happened", without the actor and place (both are drawn by the row). */
function what(row, place) {
    const where = `<span class="oc-muted">${esc(place.label)}</span>`;
    switch (row.kind) {
        case 'mention': return `mentioned you in ${where}${excerpt(row.what.excerpt)}`;
        case 'reply': return `replied to your message in ${where}${excerpt(row.what.excerpt)}`;
        case 'reaction': return `reacted ${REACTION[row.what.reaction] || esc(row.what.reaction || '')} to your message in ${where}`;
        case 'server_invite': return `invited you to ${where}`;
        case 'friend_accept': return 'accepted your friend request';
        case 'role': return `gave you the ${esc(ROLE[row.what.role] || row.what.role || '')} role in ${where}`;
        default: return `did something in ${where}`;
    }
}

/**
 * The section, or '' when there is nothing to show. `user` is the signed-in person.
 * → HTML for one <section> in the page's plain list markup.
 */
async function whatHappened(user) {
    if (!user || !user.id) return '';
    const { items } = await activity.list(user, { limit: LIMIT });
    if (!items.length) return '';
    // Seen now: the rows above keep their unread mark for this visit. Only what this page showed is read; a
    // longer feed keeps the rest unread for the next visit.
    await activity.markRead(user, { ids: items.map((row) => row.id) }).catch(() => {});
    const rows = items.map((row) => {
        const who = row.actor.display_name || row.actor.username || 'Someone';
        const at = ui.when(row.at);
        return `<li class="oc-row oc-act-row${row.read ? '' : ' oc-unread'}"><a href="${esc(row.where.href)}">
${ui.initials(who, null, { avatarUrl: row.actor.avatar_url })}
<span class="oc-row-main"><span class="oc-row-top"><strong>${esc(who)}</strong>${at.text ? `<time datetime="${esc(at.iso)}">${esc(at.text)}</time>` : ''}</span>
<span class="oc-row-sub">${what(row, row.where)}</span></span></a></li>`;
    }).join('\n');
    return `<section class="oc-act-sec" aria-labelledby="oc-act-what">
<h2 class="oc-list-head" id="oc-act-what">What happened</h2>
<ul class="oc-list">${rows}</ul>
</section>`;
}

module.exports = { whatHappened };
