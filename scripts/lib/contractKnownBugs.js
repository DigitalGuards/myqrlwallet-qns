// Compiler-independent, conservative source guards for Hyperion's known bugs.
// Keep literals as tokens so an empty string cannot disappear from an argument.
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const ELEMENTARY = /^(bytes(?:[1-9][0-9]*)?|u?int(?:[1-9][0-9]*)?|address|bool|string)$/;
const RULES = new Set([
    "verifier-arguments",
    "delete-memory-bytes",
    "storage-internal-function",
    "depositroot-storage",
    "stale-returndatasize",
    "unchecked-constant",
]);

function lex(source) {
    const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?:hex|unicode)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|[A-Za-z_$][\w$]*|0[xX][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]+)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?|:=|=>|[^\s]/g;
    const tokens = [...source.matchAll(pattern)]
        .filter((match) => !match[0].startsWith("//") && !match[0].startsWith("/*"))
        .map((match) => ({ text: match[0], at: match.index }));
    const pairs = new Map();
    const stack = [];
    const braces = [];
    for (let i = 0; i < tokens.length; i++) {
        const text = tokens[i].text;
        tokens[i].scope = braces.at(-1) ?? -1;
        if (["(", "[", "{"].includes(text)) stack.push(i);
        if (text === "{") braces.push(i);
        if ([")", "]", "}"].includes(text)) {
            const open = stack.pop();
            if (open === undefined || { "(": ")", "[": "]", "{": "}" }[tokens[open].text] !== text) {
                throw new Error("Unbalanced Hyperion source");
            }
            pairs.set(open, i);
            if (text === "}") braces.pop();
        }
    }
    if (stack.length) throw new Error("Unbalanced Hyperion source");
    return { source, tokens, pairs };
}

function callableScopes({ tokens, pairs }) {
    const scopes = [];
    for (let i = 0; i < tokens.length; i++) {
        const kind = tokens[i].text;
        if (!["function", "modifier", "constructor", "fallback", "receive"].includes(kind)) continue;
        if (kind === "function" && tokens[i + 1]?.text === "(") continue;
        let body = i + 1;
        while (body < tokens.length && !["{", ";"].includes(tokens[body].text)) {
            body = (pairs.get(body) ?? body) + 1;
        }
        if (tokens[body]?.text === "{") scopes.push({ start: i, body, end: pairs.get(body) });
    }
    return scopes;
}

// Adapted from DigitalGuards/QuantaVault's plain-local verifier argument check.
// Track declaration order, lexical scope and data location as well as spelling.
function localDeclarations(unit, fn) {
    const { tokens, pairs } = unit;
    const locals = [];
    for (let i = fn.start + 1; i < fn.end; i++) {
        const type = tokens[i].text;
        // Names inside a callback's parameter/return types belong to that type.
        if (type === "function" && tokens[i + 1]?.text === "(") {
            i = pairs.get(i + 1);
            while (["internal", "external", "pure", "view", "payable"].includes(tokens[i + 1]?.text)) i++;
            if (tokens[i + 1]?.text === "returns") i = pairs.get(i + 2);
            continue;
        }
        if (!IDENTIFIER.test(type) || tokens[i - 1]?.text === ".") continue;
        let j = i + 1;
        let dimensions = 0;
        while (tokens[j]?.text === "[") {
            dimensions++;
            j = pairs.get(j) + 1;
        }
        let location;
        if (["memory", "calldata", "storage", "payable"].includes(tokens[j]?.text)) location = tokens[j++].text;
        if (!ELEMENTARY.test(type) && !["memory", "calldata", "storage"].includes(location)) continue;
        const name = tokens[j]?.text;
        if (!IDENTIFIER.test(name || "") || !["=", ",", ")", ";"].includes(tokens[j + 1]?.text)) continue;
        let scope = i < fn.body ? fn.body : tokens[i].scope;
        let end = pairs.get(scope);
        // A for-initializer local expires at the end of that loop.
        for (let k = fn.body; k < i; k++) {
            if (tokens[k].text === "for" && tokens[k + 1]?.text === "(" && pairs.get(k + 1) > i) {
                const body = pairs.get(k + 1) + 1;
                let loopEnd = pairs.get(body) ?? body;
                while (tokens[body]?.text !== "{" && loopEnd < fn.end && tokens[loopEnd].text !== ";") loopEnd++;
                end = Math.min(end, loopEnd);
            }
            // try returns and catch parameters only exist in their own body.
            if (tokens[k].text === "(" && pairs.get(k) > i &&
                (tokens[k - 1]?.text === "returns" || tokens[k - 1]?.text === "catch" || tokens[k - 2]?.text === "catch")) {
                const body = pairs.get(k) + 1;
                if (tokens[body]?.text === "{") {
                    scope = body;
                    end = pairs.get(body);
                }
            }
        }
        let ready = fn.body;
        if (scope > i) ready = scope;
        else if (i > fn.body) {
            ready = j + 1;
            while (ready < fn.end && tokens[ready].text !== ";") ready++;
        }
        locals.push({ name, type, dimensions, location, at: j, scope, end, ready });
    }
    return locals;
}

function argumentsAt({ tokens, pairs }, open) {
    const args = [];
    let start = open + 1;
    const end = pairs.get(open);
    for (let i = start; i < end; i++) {
        if (tokens[i].text === ",") {
            args.push(tokens.slice(start, i));
            start = i + 1;
        } else if (pairs.has(i)) i = pairs.get(i);
    }
    args.push(tokens.slice(start, end));
    return args;
}

function isLiteral(tokens) {
    return tokens.length === 1 && (
        /^(?:0[xX][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]+)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?|true|false)$/.test(tokens[0].text) ||
        /^(?:hex|unicode)?["']/.test(tokens[0].text)
    );
}

function deleteTarget({ tokens, pairs }, start) {
    const target = tokens[start].text === "("
        ? { ...deleteTarget({ tokens, pairs }, start + 1), end: pairs.get(start) }
        : { root: tokens[start].text, end: start, indexes: 0, member: false };
    while (["[", "(", "."].includes(tokens[target.end + 1]?.text)) {
        if (tokens[target.end + 1].text === ".") {
            target.member = true;
            target.end += 2;
        } else {
            if (tokens[target.end + 1].text === "[") target.indexes++;
            else target.member = true;
            target.end = pairs.get(target.end + 1);
        }
    }
    return target;
}

function nonLiteralConstants(units) {
    const names = new Set();
    const aliases = [];
    for (const { tokens } of units) {
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].text === "as") aliases.push([tokens[i - 1]?.text, tokens[i + 1]?.text]);
            if (tokens[i].text !== "constant") continue;
            let name = i + 1;
            while (["public", "private", "internal"].includes(tokens[name]?.text)) name++;
            if (tokens[name + 1]?.text !== "=") continue;
            let end = name + 2;
            while (end < tokens.length && tokens[end].text !== ";") end++;
            if (!isLiteral(tokens.slice(name + 2, end))) names.add(tokens[name].text);
        }
    }
    // Imports may rename file-level constants through more than one source file.
    let changed;
    do {
        changed = false;
        for (const [name, alias] of aliases) {
            if (names.has(name) && !names.has(alias)) {
                names.add(alias);
                changed = true;
            }
        }
    } while (changed);
    return names;
}

function knownBugFindings(sources) {
    const units = Object.entries(sources).map(([file, { content }]) => ({ file, ...lex(content) }));
    const constants = nonLiteralConstants(units);
    const findings = [];
    for (const unit of units) {
        const { file, source, tokens, pairs } = unit;
        const functions = callableScopes(unit);
        for (const fn of functions) fn.locals = localDeclarations(unit, fn);
        const enclosing = (i) => functions.findLast((fn) => fn.start <= i && i < fn.end);
        const localAt = (name, i) => {
            const fn = enclosing(i);
            const local = fn?.locals.findLast((item) => item.name === name && item.at < i && item.scope <= i && i < item.end);
            return local && local.ready < i ? local : undefined;
        };
        const add = (rule, start, end, detail) => findings.push({
            rule, file, at: tokens[start].at,
            text: source.slice(tokens[start].at, tokens[end].at + tokens[end].text.length), detail,
        });
        const assemblies = [];
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].text !== "assembly") continue;
            let body = i + 1;
            while (body < tokens.length && tokens[body].text !== "{") body++;
            assemblies.push({ start: i, body, end: pairs.get(body) });
        }
        const inAssembly = (i) => assemblies.some((block) => block.body < i && i < block.end);
        const constantReads = new Set();
        for (let i = 0; i < tokens.length; i++) {
            const text = tokens[i].text;
            if (inAssembly(i)) continue;
            if (["mldsa87verify", "xmssverify", "depositroot"].includes(text) && tokens[i + 1]?.text === "(") {
                const args = argumentsAt(unit, i + 1);
                const verifier = text !== "depositroot";
                const safe = (arg) => {
                    if (!verifier && isLiteral(arg)) return true;
                    if (arg.length !== 1 || !IDENTIFIER.test(arg[0].text)) return false;
                    const local = localAt(arg[0].text, i);
                    if (!local || local.location === "storage" || (verifier && local.location === "calldata")) return false;
                    return ELEMENTARY.test(local.type) && local.dimensions === 0 &&
                        (!["bytes", "string"].includes(local.type) || ["memory", "calldata"].includes(local.location));
                };
                const wrongArity = verifier && args.length !== (text === "xmssverify" ? 3 : 4);
                if (wrongArity || args.some((arg) => !safe(arg))) {
                    add(verifier ? "verifier-arguments" : "depositroot-storage", i, pairs.get(i + 1), verifier
                        ? `${text}: use previously declared value or memory locals for every argument`
                        : "depositroot: copy storage or unclassified arguments into memory locals before the call");
                }
            }
            if (text === "delete") {
                const { root, end, indexes, member } = deleteTarget(unit, i + 1);
                if (indexes) {
                    const local = localAt(root, i);
                    const safe = local?.location === "storage" || (local && !member && ELEMENTARY.test(local.type) &&
                        (local.type !== "bytes" || indexes <= local.dimensions));
                    if (!safe) add("delete-memory-bytes", i, end, "indexed delete requires a proven non-byte memory element or a storage local; assign bytes elements to zero");
                }
            }
            if (text === "function" && tokens[i + 1]?.text === "(") {
                let end = pairs.get(i + 1) + 1;
                let external = false;
                while (["internal", "external", "pure", "view", "payable"].includes(tokens[end]?.text)) {
                    external = tokens[end].text === "external" || external;
                    end++;
                }
                if (tokens[end]?.text === "returns") end = pairs.get(end + 1) + 1;
                let statementEnd = end;
                while (statementEnd < tokens.length && ![";", "{"].includes(tokens[statementEnd].text)) statementEnd++;
                const storage = tokens.slice(end, statementEnd).some((token) => token.text === "storage");
                if (!external && (!enclosing(i) || storage)) {
                    add("storage-internal-function", i, end - 1, "internal function types are forbidden in state, struct and storage-reference declarations");
                }
            }
            if (text === "unchecked" && tokens[i + 1]?.text === "{") {
                const end = pairs.get(i + 1);
                for (let j = i + 2; j < end; j++) {
                    if (constants.has(tokens[j].text) && !constantReads.has(j) &&
                        (tokens[j - 1]?.text === "." || !localAt(tokens[j].text, j))) {
                        add("unchecked-constant", j, j, `${tokens[j].text}: evaluate non-literal constants in checked code before entering unchecked`);
                        constantReads.add(j);
                    }
                }
            }
        }
        for (const block of assemblies) {
            const calls = new Set(["call", "callcode", "delegatecall", "staticcall", "create", "create2"]);
            for (let i = block.body; i < block.end; i++) {
                if (tokens[i].text === "function") calls.add(tokens[i + 1].text);
            }
            for (let i = block.body; i < block.end; i++) {
                if (tokens[i].text !== ":=") continue;
                const value = i + 1;
                const valueEnd = tokens[value + 1]?.text === "(" ? pairs.get(value + 1) : value;
                if (!tokens.slice(value, valueEnd + 1).some((token) => token.text === "returndatasize")) continue;
                // Reject a snapshot before any later external or Yul helper call
                // in this block, even if a branch or reassignment may discard it.
                const later = tokens.findIndex((token, index) => index > valueEnd && index < block.end &&
                    calls.has(token.text) && tokens[index + 1]?.text === "(" && tokens[index - 1]?.text !== "function");
                const repeated = tokens.some((token, index) => index > block.body && index < i &&
                    ["for", "function"].includes(token.text));
                const otherCall = tokens.some((token, index) => index > block.body && index < block.end &&
                    calls.has(token.text) && tokens[index + 1]?.text === "(" && tokens[index - 1]?.text !== "function");
                const compoundCall = tokens.some((token, index) => index >= value && index <= valueEnd &&
                    calls.has(token.text) && tokens[index + 1]?.text === "(");
                // A snapshot assigned to a Hyperion local can outlive this block.
                const exported = localAt(tokens[i - 1].text, block.start);
                const fn = enclosing(block.start);
                const followingCall = exported && tokens.some((token, index) => index > block.end && index < fn.end &&
                    IDENTIFIER.test(token.text) && tokens[index + 1]?.text === "(" &&
                    (inAssembly(index) ? calls.has(token.text) : !["if", "for", "while", "require", "assert"].includes(token.text)));
                if (later >= 0 || (repeated && otherCall) || compoundCall || followingCall) {
                    add("stale-returndatasize", i - 1, valueEnd, "returndatasize snapshot can cross a later call; loops, helpers and exported locals are checked conservatively");
                }
            }
        }
    }
    return findings;
}

module.exports = { KNOWN_BUG_RULES: RULES, knownBugFindings };
