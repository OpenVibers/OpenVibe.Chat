'use strict';
/**
 * OpenVibe.Chat — the check a chat plays request passes before it is queued (Agent Streams S6, §2).
 *
 * A request is written with '!do <request>' in an agent stream's room. It passes the house text filters and
 * this safety check before it is listed; a refused request never enters the queue, and the room gets one
 * line saying why.
 *
 * The rules, in the design's words:
 *   - the platform floor (the house text filters: unsafe words and spam);
 *   - no harm to people;
 *   - no attacks, scanning or spam;
 *   - nothing that needs an account or money (the desk has neither).
 *
 * The check is a plain function of the text, so it can be tested on its own and so the same line is given
 * every time. It never says what it matched: the reason is one line for the room, not a rule book.
 */
const wordFilter = require('./word-filter');

const MAX_CHARS = 200;

// The one line the room sees for each refusal.
const REASONS = {
    platform_floor: 'That one is refused: it does not pass the house text filters.',
    harm: "That one is refused: it asks for something that could hurt someone.",
    attack: "That one is refused: it asks for something that attacks or scans other people's systems.",
    account_or_money: 'That one is refused: it needs an account or money, and the desk has neither.',
    account_too_new: 'That one is refused: an account younger than a day cannot ask.',
    too_long: 'That one is refused: a request is at most 200 characters.',
    already_open: 'You already have an open request in the queue.',
};

// Something that could hurt people. The object matters: 'kill the boss in the game' is a game, and
// 'kill my neighbour' is not.
const PERSON = '(?:people|persons?|someone|somebody|him|her|them|they|my|his|their|neighbou?rs?|friends?|classmates?|bystanders?|crowd|children|kids?|brothers?|sisters?|wife|husband|students?|teacher|roommate)';
const HARM = [
    /\b(murder|maim|torture|strangle|genocide|massacre|assassinate)\b/i,
    new RegExp('\\b(kill|shoot|bomb|poison|beat|attack|hurt|harm|stab|strangle)\\s+(?:' + PERSON + ')\\b', 'i'),
    /\b(suicide|self[\s-]?harm|kill\s+myself|end\s+my\s+life)\b/i,
    /\b(dox|doxx|swat)\b/i,
    /\b(hate\s+speech|racist|racism|slur)\b/i,
];

// Attacks, scanning, spam: anything that reaches for a system that is not the desk's own.
const ATTACK = [
    /\b(hack|hacking|exploit|exploiting|breach|intrude|backdoor|rootkit|malware|ransomware|keylogger|botnet)\b/i,
    /\b(ddos|denial[\s-]?of[\s-]?service|port[\s-]?scan|scanning|nmap|masscan|sql[\s-]?injection|xss|csrf)\b/i,
    /\b(reverse\s+shell|shell\s+payload|exfiltrate|data\s+exfil)\b/i,
    /\b(brute[\s-]?force|crack|steal|stealing|sniff|dump\s+the\s+(users|passwords|secrets))\b/i,
    /\b(pastebin|paste\s?bin|ghostbin|hastebin)\b/i,
    // "print the env", "show me the api key": it wants something out of the desk that the desk does not have.
    /\b(print|show|dump|reveal|leak|list|cat|echo|send|post|upload|share)\b[^.!?]{0,30}\b(env|environ|environment|secret|api[\s-]?key|token|password|credential|keychain)\b/i,
];

// Something that needs an account, a key or money: the desk has none of them.
const ACCOUNT_OR_MONEY = [
    /\b(sign\s?up|register|create\s+an?\s+account|log\s?in|log\s?in|login)\b/i,
    /\b(buy|purchase|pay|payment|checkout|order|subscribe|subscription|premium|upgrade)\b/i,
    /\b(credit\s+card|debit\s+card|card\s+number|cvv|invoice|donate|tip|wallet|crypto|bitcoin|gift\s+card|coupon)\b/i,
    /\b(api[\s-]?key|access\s+key|private\s+key|ssh\s+key|oauth\s+token|client\s+secret)\b/i,
    /\b(open\s+an?\s+account|get\s+me\s+(a|an)\s+(account|number|line))\b/i,
];

/**
 * The check. It answers { ok: true } or { ok: false, code, reason } — the code is the rule that turned it
 * down and the reason is the one line the room sees.
 */
function check(text) {
    const body = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!body) return { ok: false, code: 'platform_floor', reason: REASONS.platform_floor };
    if (body.length > MAX_CHARS) return { ok: false, code: 'too_long', reason: REASONS.too_long };
    // The house text filters: unsafe words and spam.
    const filtered = wordFilter.check(body);
    if (!filtered.safe || wordFilter.isSpam(body)) {
        return { ok: false, code: 'platform_floor', reason: REASONS.platform_floor };
    }
    if (HARM.some((re) => re.test(body))) return { ok: false, code: 'harm', reason: REASONS.harm };
    if (ATTACK.some((re) => re.test(body))) return { ok: false, code: 'attack', reason: REASONS.attack };
    if (ACCOUNT_OR_MONEY.some((re) => re.test(body))) return { ok: false, code: 'account_or_money', reason: REASONS.account_or_money };
    return { ok: true, text: body };
}

module.exports = { MAX_CHARS, REASONS, check };
