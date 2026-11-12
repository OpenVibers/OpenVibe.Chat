'use strict';
/**
 * /admin/persona — the owner's page for Vibe personas (the owner, 2026-11-12: "the cheapest model possible, but
 * configurable on the admin panel … make it actually intelligent"). It is Chat's own owner panel because the
 * actions are Chat's (which model, when to re-check, how much a month, remake one chat), not a service key;
 * Network's owner settings proxy still reaches the same `chat.persona` namespace through /internal/config.
 *
 *   GET  /admin/persona            the settings, what this month has cost, the model choices and the chats
 *   POST /admin/persona            save the settings (form)
 *   POST /admin/persona/remake     { slug } remake one conversation's persona (form)
 *
 * Owner only: an admin with Network's owner flag. Every model call is Chat's own and billed to Chat; the cap is
 * read from the runs' usage, not counted by attempts.
 */
const persona = require('../persona');
const { isOwner } = require('../auth/permissions');
const { esc } = require('./layout');
const ui = require('./ui');

const usd = (n) => {
    const v = Number(n) || 0;
    const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return `$${s || '0'}`;
};
const priceLabel = (p) => (p ? `$${Number(p.in).toFixed(2)} in / $${Number(p.out).toFixed(2)} out per M` : 'price unknown');
const glyph = (p) => (p ? `${esc(p.glyph)} · hue ${Number(p.hue)}` : 'not made yet');

function modelSelect(name, current, options, autoLabel) {
    const known = options.slice();
    if (current && !known.some((m) => m.id === current)) known.unshift({ id: current, name: current, price: null });
    return `<label class="oc-set-row"><span class="oc-set-text">${name}<small>${esc(autoLabel)}</small></span>
<select name="${name === 'Text model' ? 'text_model' : 'image_model'}">
<option value=""${current ? '' : ' selected'}>Auto — the cheapest in the catalogue</option>
${known.map((m) => `<option value="${esc(m.id)}"${m.id === current ? ' selected' : ''}>${esc(m.name)} · ${esc(priceLabel(m.price))}</option>`).join('')}
</select></label>`;
}

function conversationRows(rows) {
    if (!rows.length) return '<p class="oc-muted">No Vibe conversations yet.</p>';
    return `<ul class="oc-list">${rows.map((r) => `<li class="oc-row">
<span class="oc-row-main"><span class="oc-row-top"><strong>${esc(r.persona ? r.persona.name : r.name || 'Chat with Vibe')}</strong> <span class="oc-muted">${esc(r.slug)}</span></span>
<span class="oc-row-sub">${r.persona ? `${glyph(r.persona)} · ${esc(r.persona.topic)}` : 'no persona yet'} · ${Number(r.messages)} messages</span></span>
<form class="oc-inline" method="post" action="/admin/persona/remake"><input type="hidden" name="slug" value="${esc(r.slug)}"><button class="oc-link" type="submit">Remake</button></form>
</li>`).join('')}</ul>`;
}

function pageBody(state, message) {
    const s = state.settings;
    const spend = state.spend;
    const capLine = spend.reached
        ? `<p class="oc-notice oc-error" role="status">The monthly cap is reached (${usd(spend.usd)} of ${usd(spend.cap_usd)}). Existing personas stay; new ones wait for next month or a higher cap.</p>`
        : `<p class="oc-muted">Spent <strong>${usd(spend.usd)}</strong> of <strong>${usd(spend.cap_usd)}</strong> this month (${esc(spend.month)} UTC), ${usd(spend.remaining_usd)} left. A persona is named by the cheapest chat model and the cap is read from each run's own usage.</p>`;
    const revision = state.revision ? ` · revision ${Number(state.revision)}` : '';
    return `${message}${ui.head({ title: 'Vibe personas', sub: 'Names and faces for Vibe chats, made from what each chat is about' })}
<section class="oc-set" aria-labelledby="persona-spend"><h2 id="persona-spend">This month</h2>${capLine}${revision ? `<p class="oc-muted">Owner settings${esc(revision)}.</p>` : ''}</section>
<section class="oc-set" aria-labelledby="persona-settings"><h2 id="persona-settings">Settings</h2>
<form class="oc-form" method="post" action="/admin/persona">
<label class="oc-set-row"><span class="oc-set-text">Names and faces for Vibe chats<small>Off: no model is called and no persona is made or checked.</small></span><input type="checkbox" class="oc-switch" name="enabled" value="1"${s.enabled ? ' checked' : ''}></label>
${modelSelect('Text model', s.text_model, state.models.text, 'The cheapest chat model is used automatically when this is Auto.')}
<label class="oc-set-row"><span class="oc-set-text">Avatar pictures<small>Off by default: an image costs more than the name. Pictures go to OpenVibe.Media.</small></span><input type="checkbox" class="oc-switch" name="images" value="1"${s.images ? ' checked' : ''}></label>
${modelSelect('Image model', s.image_model, state.models.image, 'The cheapest image model is used automatically when this is Auto and pictures are on.')}
<label>Messages between topic checks <input type="number" name="check_every" min="2" max="100" step="1" value="${esc(s.check_every)}" required></label>
<label>Monthly spend cap (USD) <input type="number" name="monthly_cap_usd" min="0" max="1000" step="0.01" value="${esc(s.monthly_cap_usd)}" required></label>
<p class="oc-muted">The name is also the conversation's title until the person renames it. A chat is checked after its first answer and then every ${esc(s.check_every)} messages; a changed topic makes a new name and face.</p>
<p><button class="oc-button" type="submit">Save</button></p>
</form></section>
<section class="oc-set" aria-labelledby="persona-chats"><h2 id="persona-chats">Conversations</h2>
<p class="oc-muted">Your newest ${state.conversations.length} Vibe conversations (other people's are private: only the spend above counts them). Remake asks the model now, counts against the cap, and keeps the person's own title if they renamed the chat.</p>
${conversationRows(state.conversations)}</section>`;
}

function mountPersonaAdmin(router, { page, needUser, sameSite, formLimit, notice }) {
    async function owner(req, res) {
        const actor = await needUser(req, res);
        if (!actor) return null;
        if (!isOwner(actor.user)) {
            await page(req, res, 403, {
                actor, title: 'Vibe personas', path: '/admin/persona', robots: 'noindex, nofollow', footer: 'compact',
                body: `<h1>Only the owner</h1><p>This page changes what Chat may spend on Vibe personas. It is for OpenVibe's owner.</p><p><a href="/vibe">Back to Vibe</a></p>`,
            });
            return null;
        }
        return actor;
    }

    router.get('/admin/persona', async (req, res) => {
        const actor = await owner(req, res); if (!actor) return;
        let state;
        try { state = await persona.state(actor.user.id); } catch (err) {
            console.warn('[Vibe persona admin page]', err && err.message);
            return await page(req, res, 503, {
                actor, title: 'Vibe personas', path: '/admin/persona', robots: 'noindex, nofollow', footer: 'compact',
                body: '<h1>Vibe personas</h1><p>The persona settings are not available right now. The Chat log says why.</p>',
            });
        }
        const saved = req.query.remade ? notice('ok', 'Persona remade.')
            : req.query.saved ? notice('ok', `Saved${state.revision ? ` (revision ${state.revision})` : ''}.`)
                : req.query.error ? notice('error', String(req.query.error).slice(0, 240)) : '';
        await page(req, res, 200, {
            actor, title: 'Vibe personas', path: '/admin/persona', active: 'settings', robots: 'noindex, nofollow', shell: false, footer: 'compact',
            body: pageBody(state, saved),
        });
    });

    router.post('/admin/persona', formLimit, sameSite, async (req, res) => {
        const actor = await owner(req, res); if (!actor) return;
        const b = req.body || {};
        try {
            await persona.update({
                enabled: b.enabled === '1',
                images: b.images === '1',
                text_model: b.text_model == null ? undefined : String(b.text_model).slice(0, 200),
                image_model: b.image_model == null ? undefined : String(b.image_model).slice(0, 200),
                check_every: b.check_every,
                monthly_cap_usd: b.monthly_cap_usd,
            }, { actor: actor.user.subject_id ? { type: 'user', id: String(actor.user.subject_id) } : null, reason: 'Vibe persona settings (owner page)' });
            res.redirect(303, '/admin/persona?saved=1#persona-settings');
        } catch (err) {
            const message = err && err.status ? err.message : 'The settings could not be saved right now';
            res.redirect(303, `/admin/persona?error=${encodeURIComponent(message)}#persona-settings`);
        }
    });

    router.post('/admin/persona/remake', formLimit, sameSite, async (req, res) => {
        const actor = await owner(req, res); if (!actor) return;
        try {
            await persona.remake(String((req.body && req.body.slug) || ''), actor.user.id);
            res.redirect(303, '/admin/persona?remade=1#persona-chats');
        } catch (err) {
            const message = err && err.status ? err.message : 'That conversation could not be remade right now';
            res.redirect(303, `/admin/persona?error=${encodeURIComponent(message)}#persona-chats`);
        }
    });
}

module.exports = { mountPersonaAdmin, pageBody, modelSelect, conversationRows, usd, priceLabel };
