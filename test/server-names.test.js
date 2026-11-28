'use strict';
// No server module uses a name that nothing declares (11-28, a scan of every repo's server code: a route that read
// req through a parameter named _req, a helper that read another route's variable, a function or class never
// imported). node --check and the tests that never take that path cannot see these; the request that does gets a 500.
// Every server/ file is parsed with acorn and its scopes followed; a name is declared when a scope declares it or it is
// one of Node's globals (read here) or the browser's (test/fixtures/browser-globals.json: pages the server writes
// carry their own scripts).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const GLOBALS = new Set(require('./fixtures/browser-globals.json').names.concat(['require', 'module', 'exports', '__dirname', '__filename', 'undefined', 'NaN', 'Infinity']));
for (let o = globalThis; o; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach((n) => GLOBALS.add(n));
const want = (name) => !GLOBALS.has(name);
function declaredIn(pattern, out) {
    if (!pattern) return;
    switch (pattern.type) {
        case 'Identifier': out.add(pattern.name); break;
        case 'ObjectPattern': pattern.properties.forEach((p) => declaredIn(p.type === 'RestElement' ? p.argument : p.value, out)); break;
        case 'ArrayPattern': pattern.elements.forEach((e) => declaredIn(e, out)); break;
        case 'AssignmentPattern': declaredIn(pattern.left, out); break;
        case 'RestElement': declaredIn(pattern.argument, out); break;
        default: break;
    }
}
// Hoisting: collect every name a function (or the program) declares anywhere in its body, not inside nested functions.
function hoisted(body, out, blockOnlyTop) {
    const visit = (n, top) => {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'FunctionDeclaration') { if (n.id) out.add(n.id.name); return; }
        if (/Function/.test(n.type) || n.type === 'ClassExpression') return;
        if (n.type === 'VariableDeclaration') n.declarations.forEach((d) => declaredIn(d.id, out));
        if (n.type === 'ClassDeclaration' && n.id) out.add(n.id.name);
        if (n.type === 'ImportDeclaration') n.specifiers.forEach((s) => out.add(s.local.name));
        for (const k of Object.keys(n)) {
            if (k === 'type' || k === 'start' || k === 'end') continue;
            const v = n[k];
            if (Array.isArray(v)) v.forEach((c) => visit(c, false)); else if (v && typeof v.type === 'string') visit(v, false);
        }
    };
    (Array.isArray(body) ? body : [body]).forEach((n) => visit(n, true));
    return out;
}
function check(file, acorn, want) {
    const src = fs.readFileSync(file, 'utf8');
    let ast;
    try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true }); } catch {
        try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); } catch (e) { return [`${file}: parse error ${e.message}`]; }
    }
    const hits = [];
    const walk = (n, scopes, parent, key) => {
        if (!n || typeof n.type !== 'string') return;
        let inner = scopes;
        if (/Function/.test(n.type)) {
            const s = new Set();
            if (n.id && n.type !== 'FunctionDeclaration') s.add(n.id.name);
            n.params.forEach((p) => declaredIn(p, s));
            if (n.body && n.body.type === 'BlockStatement') hoisted(n.body.body, s);
            s.add('arguments');
            inner = scopes.concat([s]);
        } else if (n.type === 'CatchClause' && n.param) {
            const s = new Set(); declaredIn(n.param, s); inner = scopes.concat([s]);
        } else if (n.type === 'ClassExpression' && n.id) {
            inner = scopes.concat([new Set([n.id.name])]);
        }
        if (n.type === 'Identifier' && want(n.name)) {
            const isProp = parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed) || (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) || (parent.type === 'MethodDefinition' && key === 'key') || (parent.type === 'PropertyDefinition' && key === 'key'));
            const isLabel = parent && /Label|Break|Continue/.test(parent.type);
            if (!isProp && !isLabel && !inner.some((s) => s.has(n.name))) {
                const line = src.slice(0, n.start).split('\n').length;
                hits.push(`${file}:${line}: ${n.name}: ${src.split('\n')[line - 1].trim().slice(0, 120)}`);
            }
        }
        for (const k of Object.keys(n)) {
            if (k === 'type' || k === 'start' || k === 'end') continue;
            const v = n[k];
            if (Array.isArray(v)) v.forEach((c) => walk(c, inner, n, k)); else if (v && typeof v.type === 'string') walk(v, inner, n, k);
        }
    };
    const top = hoisted(ast.body, new Set());
    walk(ast, [top], null, null);
    return hits;
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (/^(node_modules|vendor|public|dist|fixtures)$/.test(e.name) ? [] : walk(path.join(d, e.name))) : (/\.c?js$/.test(e.name) ? [path.join(d, e.name)] : [])));
const files = walk(path.join(ROOT, 'server'));
assert.ok(files.length > 3, `the server's modules are found (${files.length})`);
const found = [...new Set(files.flatMap((f) => check(f, acorn, want)))].map((h) => h.replace(ROOT + path.sep, ''));
assert.deepStrictEqual(found, [], `names nothing declares:\n${found.join('\n')}`);
console.log(`server-names: ${files.length} server modules use no undeclared name`);
