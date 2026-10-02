'use strict';
/**
 * Route ids. PostgreSQL rejects a NaN / zero / negative integer parameter where SQLite matched no
 * rows, so after the engine move an unvalidated parseInt turned a mistyped URL (e.g.
 * /api/emotes/channel/abc) into a 500. Every :userId/:id route validates its param first and
 * answers 400 "invalid … id" instead.
 */

/** A route param that must be a positive integer; null when it is not one. */
function positiveInt(value) {
    const s = typeof value === 'string' ? value : String(value == null ? '' : value);
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Express router.param handler: 400 for a non-positive-integer param, else next(). */
function idParam(message) {
    return (req, res, next, value) => {
        if (positiveInt(value) === null) return res.status(400).json({ error: message });
        next();
    };
}

module.exports = { positiveInt, idParam };
