// TTS reads an emote by its name only (the owner, 2026-11-06): no brackets, colons or numeric ids from Kick or
// Discord, and emote spam is read once. server/chat/tts-engine.js speakableEmotes, used by sanitize().
const assert = require('assert');
const { speakableEmotes, sanitize } = require('../server/chat/tts-engine');

const cases = [
    ['lol [emote:37226:KEKLEO] that was funny', 'lol KEKLEO that was funny', "Kick's [emote:id:Name] is read as its name"],
    ['[emoji:emojiSmile]', 'emojiSmile', "Kick's [emoji:Name] too"],
    ['hi <:pepe_hands:123456789> and <a:catJAM:42>', 'hi pepe hands and catJAM', "Discord's <:name:id> and <a:name:id>, underscores as spaces"],
    ['nice :PogChamp: play', 'nice PogChamp play', 'a :shortcode: loses its colons'],
    ['[emote:1:KEKW] [emote:1:KEKW] [emote:1:KEKW] [emote:1:KEKW]', 'KEKW', 'emote spam is read once'],
    ['yes yes yes yes', 'yes', 'any word said three or more times in a row is read once'],
    ['no no', 'no no', 'two in a row stay'],
    ['time 10:30:45 ok', 'time 10:30:45 ok', 'a clock time is not an emote'],
];
for (const [input, want, why] of cases) assert.strictEqual(speakableEmotes(input), want, why);

// Through sanitize: the <> strip comes after, so Discord's form never leaves ":name:123" to be read.
assert.strictEqual(sanitize('wow <:pog:123>', 500, 'bob'), 'wow pog');
assert.ok(!/\d{3,}/.test(sanitize('gg [emote:37226:KEKLEO]', 500, 'bob')), 'no numeric emote id is spoken');

console.log(`tts-emotes: ${cases.length + 2} checks passed`);
