'use strict';
/**
 * Vibe's system prompt keeps a byte-identical prefix (stage S3, cache-stable prompts): the rules first, then what
 * changes — the memory setting, their notes, and the date line, which moves every minute and is therefore last.
 * The tools are offered in the same order every turn of a chat.
 */
const assert = require('assert');
const { suite } = require('./helpers');
const { vibePrompt } = require('../server/rooms/ai-members');
const aiTools = require('../server/rooms/ai-tools');

const t = suite('vibe-prompt-prefix');
const member = { name: 'Vibe', handle: 'vibe', persona: null };
const at = Date.UTC(2026, 10, 9, 9, 30);
const later = Date.UTC(2026, 10, 9, 14, 45);

/** The instruction block: everything before the first line that depends on the person's memory. */
const rulesOf = (s) => {
    const at = s.indexOf('\n- Their memory is off');
    return s.slice(0, at >= 0 ? at : s.indexOf('\n- Memory:'));
};
/** The rules and the memory line, before their notes. */
const withoutNotes = (s) => {
    const at = s.indexOf('\n\nWhat you remember about');
    return at >= 0 ? s.slice(0, at) : s;
};

t('the rules are the same prefix from one minute to the next', () => {
    const a = vibePrompt(member, 'Ann', null, { now: at });
    const b = vibePrompt(member, 'Ann', null, { now: later, timezone: 'Asia/Tokyo' });
    assert.ok(a.startsWith("You are Vibe, OpenVibe's assistant, in a private chat with Ann on OpenVibe.Chat."));
    assert.ok(rulesOf(a).length > 1500, `the whole instruction block is stable (${rulesOf(a).length} bytes)`);
    assert.strictEqual(rulesOf(a), rulesOf(b), 'a different clock leaves the rules prefix byte-identical');
    assert.notStrictEqual(a, b, 'the date line itself differs');
    assert.match(a, /\nToday is .*\(UTC\)\.$/);
    assert.match(b, /\nToday is .*for Ann it is .* in Asia\/Tokyo\.$/);
});

t('a person\'s notes and their memory setting change only the tail', () => {
    const off = vibePrompt(member, 'Ann', null, { now: at });
    const on = vibePrompt(member, 'Ann', '[12] likes tea', { now: at });
    assert.strictEqual(rulesOf(off), rulesOf(on), 'turning memory on leaves the rules byte-identical');
    assert.match(withoutNotes(on), /- Memory: when they ask you to remember something/);
    assert.ok(withoutNotes(on).endsWith('They see and delete the notes on openvibe.chat/vibe/memory.'));
    const other = vibePrompt(member, 'Ann', '[13] likes coffee', { now: at });
    assert.strictEqual(withoutNotes(on), withoutNotes(other), 'new notes leave the rules and the memory rule byte-identical');
    assert.match(on, /\n\nWhat you remember about Ann \(their notes, newest first\):\n\[12\] likes tea\nToday is /);
});

t('the tools are offered in the same order every turn', () => {
    const room = { id: 7, assistant: 1, workspace: 0 };
    const first = aiTools.definitions(member, room, { memory: true });
    const second = aiTools.definitions(member, room, { memory: true });
    assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
    const names = first.map((d) => d.function.name);
    assert.strictEqual(new Set(names).size, names.length, 'no tool is offered twice');
});

t.run();
