// Contract lint and warning gate for the Hyperion sources under contracts/.
//
// Source rules (no compiler needed; CI runs them with --source-only):
//   hyperion-only    no Solidity sources or Foundry/Slither configuration in the repository
//   pragma           exactly one `pragma hyperion >=0.0;` per file; the compiler
//                    identity is pinned by config/hyperion-toolchain.json
//   tx-origin        no tx.origin
//   assembly         no inline assembly
//   low-level-call   every call, delegatecall, staticcall or send result is checked
//   visibility       explicit visibility on state variables and functions
//   verifier-arguments        plain value/memory locals for both PQ verifiers
//   delete-memory-bytes       no indexed delete on bytes in memory
//   storage-internal-function no stored internal function types
//   depositroot-storage       materialize storage arguments before depositroot
//   stale-returndatasize       no assembly size snapshot across a later call
//   unchecked-constant        evaluate non-literal constants in checked code
//   event            every public or external state-changing function emits an
//                    event itself or through a helper in the same contract
// Compiler rule (pinned hypc, four codegen modes): no warning outside the
// allowlist. Every exception in config/contract-lint-allowlist.json is bound
// to a fingerprint of the exact source it covers and carries a reason; a new or
// changed finding fails, and so does an unused entry.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { KNOWN_BUG_RULES, knownBugFindings } = require("./lib/contractKnownBugs");

const root = path.resolve(__dirname, "..");
const ALLOWLIST_PATH = path.join(root, "config", "contract-lint-allowlist.json");
const PRAGMA = "pragma hyperion >=0.0;";
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const modes = [
    { name: "legacy", viaIR: false, optimize: false },
    { name: "legacy-optimized", viaIR: false, optimize: true },
    { name: "via-ir", viaIR: true, optimize: false },
    { name: "via-ir-optimized", viaIR: true, optimize: true },
];

function sourcesIn(directory = path.join(root, "contracts")) {
    const sources = {};
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Contract symlink: ${file}`);
        if (entry.isDirectory()) Object.assign(sources, sourcesIn(file));
        else if (entry.name.endsWith(".hyp")) {
            sources[path.relative(root, file).split(path.sep).join("/")] = { content: fs.readFileSync(file, "utf8") };
        }
    }
    return sources;
}

// Owner rule: Hyperion only. Solidity sources and Foundry or Slither
// configuration are refused anywhere outside dependency and build output.
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "build", "dist", "cache", "out", "coverage"]);
const FORBIDDEN_FILES = /\.sol$|^foundry\.toml$|^slither\.config\.json$|^remappings\.txt$/;
function hyperionOnlyFindings(directory = root) {
    const findings = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) findings.push(...hyperionOnlyFindings(file));
        else if (FORBIDDEN_FILES.test(entry.name)) {
            const relative = path.relative(root, file).split(path.sep).join("/");
            findings.push({ rule: "hyperion-only", file: relative, line: 0, fingerprint: hash(relative), detail: "Solidity or Foundry/Slither file" });
        }
    }
    return findings;
}

// Preserve offsets while removing comments and literal contents. Strings cannot
// satisfy a policy rule or hide a declaration. Braces inside strings are ignored.
function masked(source) {
    return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (value) =>
        value.replace(/[^\n]/g, " ")
    );
}

function declarations(source) {
    const clean = masked(source);
    const tokens = [...clean.matchAll(/[A-Za-z_$][\w$]*|[^\s]/g)].map((m) => ({ text: m[0], at: m.index }));
    const pairs = new Map();
    const stack = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i].text;
        if (["(", "{", "["].includes(t)) stack.push(i);
        if ([")", "}", "]"].includes(t)) {
            const start = stack.pop();
            if (start === undefined || "({[".indexOf(tokens[start].text) !== ")}]".indexOf(t)) {
                throw new Error("Unbalanced Hyperion source");
            }
            pairs.set(start, i);
        }
    }
    if (stack.length) throw new Error("Unbalanced Hyperion source");
    const functions = [];
    const variables = [];
    for (let i = 0; i < tokens.length; i++) {
        if (!["contract", "library", "interface"].includes(tokens[i].text)) continue;
        const kind = tokens[i].text;
        const contract = tokens[i + 1].text;
        while (tokens[i].text !== "{") i++;
        const end = pairs.get(i);
        for (let j = i + 1; j < end; ) {
            const start = j;
            while (j < end && ![";", "{"].includes(tokens[j].text)) {
                if (["(", "["].includes(tokens[j].text)) j = pairs.get(j);
                j++;
            }
            const header = clean.slice(tokens[start].at, tokens[j].at);
            const bodyStart = j;
            if (tokens[j].text === "{") j = pairs.get(j);
            const text = source.slice(tokens[start].at, tokens[j].at + 1);
            const match = /^(function\s+(\w+)|constructor|fallback|receive)\b/.exec(header);
            if (match) {
                functions.push({
                    contract,
                    kind,
                    name: match[2] || match[1],
                    header,
                    body: tokens[bodyStart].text === "{" ? clean.slice(tokens[bodyStart].at, tokens[j].at + 1) : "",
                    bodyAt: tokens[bodyStart].at,
                    at: tokens[start].at,
                    text,
                });
            } else if (tokens[bodyStart].text === ";" && !/^(event|error|using)\b/.test(header)) {
                variables.push({ contract, header, at: tokens[start].at, text });
            }
            j++;
        }
        i = end;
    }
    return { clean, functions, variables };
}

// A low-level call result is checked when the call sits in a require, assert,
// if or return, or when its success flag is captured and later tested.
function uncheckedLowLevelCalls(body) {
    const unchecked = [];
    for (const match of body.matchAll(/\.\s*(call|delegatecall|staticcall|send)\s*(\{|\()/g)) {
        const before = body.slice(0, match.index);
        const start = Math.max(before.lastIndexOf(";"), before.lastIndexOf("{"), before.lastIndexOf("}")) + 1;
        const endIndex = body.indexOf(";", match.index);
        const statement = body.slice(start, endIndex < 0 ? body.length : endIndex).trim();
        let checked = /^(require|assert)\s*\(|^if\s*\(|^return\b/.test(statement);
        const capture =
            /^\(\s*(?:bool\s+)?([A-Za-z_]\w*)\s*[,)]/.exec(statement) || /^bool\s+([A-Za-z_]\w*)\s*=/.exec(statement);
        if (!checked && capture) {
            const rest = body.slice(endIndex < 0 ? body.length : endIndex);
            const name = capture[1];
            checked = new RegExp(
                `(?:require|assert)\\s*\\(\\s*!?\\s*${name}\\b|if\\s*\\(\\s*!?\\s*${name}\\b|return\\s+!?\\s*${name}\\b`
            ).test(rest);
        }
        if (!checked) unchecked.push({ at: match.index, kind: match[1] });
    }
    return unchecked;
}

function sourceFindings(sources) {
    const findings = knownBugFindings(sources).map(({ at, text, ...finding }) => ({
        ...finding,
        line: sources[finding.file].content.slice(0, at).split("\n").length,
        fingerprint: hash(text),
    }));
    for (const [file, { content }] of Object.entries(sources)) {
        const { clean, functions, variables } = declarations(content);
        const add = (rule, at, text, detail) =>
            findings.push({
                rule,
                file,
                line: content.slice(0, at).split("\n").length,
                fingerprint: hash(text),
                detail,
            });
        const enclosing = (index) => functions.find((f) => index >= f.at && index < f.at + f.text.length);
        const pragmas = [...clean.matchAll(/pragma\s+[^;]+;/g)];
        if (pragmas.length !== 1 || pragmas[0][0].replace(/\s+/g, " ") !== PRAGMA) {
            add("pragma", 0, content, `require exactly one "${PRAGMA}"`);
        }
        for (const [rule, pattern, detail] of [
            ["tx-origin", /\btx\s*\.\s*origin\b/g, "tx.origin is not an authorization source"],
            ["assembly", /\bassembly\b/g, "inline assembly needs a reviewed exception"],
        ]) {
            for (const match of clean.matchAll(pattern)) {
                add(rule, match.index, enclosing(match.index)?.text || content, detail);
            }
        }
        for (const fn of functions) {
            for (const call of uncheckedLowLevelCalls(fn.body)) {
                add("low-level-call", fn.bodyAt + call.at, fn.text, `${fn.contract}.${fn.name}: unchecked ${call.kind} result`);
            }
        }
        for (const variable of variables) {
            if (!/\b(public|private|internal)\b/.test(variable.header)) {
                add("visibility", variable.at, variable.text, `${variable.contract}: implicit state-variable visibility`);
            }
        }
        const emits = (fn, seen = new Set()) => {
            if (seen.has(fn)) return false;
            seen.add(fn);
            if (/\bemit\s+\w+\s*\(/.test(fn.body)) return true;
            return functions.some(
                (callee) =>
                    callee.contract === fn.contract &&
                    new RegExp(`(?<![\\w.])${callee.name}\\s*\\(`).test(fn.body) &&
                    emits(callee, seen)
            );
        };
        for (const fn of functions) {
            if (fn.name === "constructor") continue;
            if (!/\b(public|external|private|internal)\b/.test(fn.header)) {
                add("visibility", fn.at, fn.text, `${fn.contract}.${fn.name}: implicit function visibility`);
            }
            if (fn.body && /\b(public|external)\b/.test(fn.header) && !/\b(view|pure)\b/.test(fn.header) && !emits(fn)) {
                add("event", fn.at, fn.text, `${fn.contract}.${fn.name}: no event emitted directly or by a local helper`);
            }
        }
    }
    return findings;
}

function checkAllowlist(findings, allowances, label, log = console.log) {
    for (const entry of allowances) {
        if (KNOWN_BUG_RULES.has(entry.rule)) throw new Error(`Rule ${entry.rule} cannot be allowlisted`);
    }
    const used = new Set();
    const unmatched = findings.filter((finding) => {
        const index = allowances.findIndex(
            (entry) =>
                typeof entry.reason === "string" &&
                entry.reason.trim().length >= 20 &&
                entry.rule === finding.rule &&
                entry.file === finding.file &&
                entry.fingerprint === finding.fingerprint
        );
        if (index < 0) return true;
        used.add(index);
        return false;
    });
    for (const finding of findings) {
        const status = unmatched.includes(finding) ? "NEW" : "allowlisted";
        log(`${label}: ${status} ${finding.file}:${finding.line || 0} ${finding.rule} ${finding.detail}`);
    }
    if (unmatched.length) throw new Error(`${label}: ${unmatched.length} finding(s) without a reviewed allowlist entry`);
    if (used.size !== allowances.length) {
        const stale = allowances.filter((_, index) => !used.has(index)).map((entry) => `${entry.file} ${entry.rule}`);
        throw new Error(`${label}: stale, duplicate or malformed allowlist entries: ${stale.join("; ")}`);
    }
    return findings.length;
}

function compileMode(compiler, sources, mode) {
    const result = spawnSync(compiler, ["--standard-json"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        input: JSON.stringify({
            language: "Hyperion",
            sources,
            settings: {
                viaIR: mode.viaIR,
                optimizer: { enabled: mode.optimize, runs: 200 },
                outputSelection: { "*": { "*": ["abi", "qrvm.bytecode.object"] } },
            },
        }),
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.stderr.trim()) throw new Error(result.stderr || `Compiler exit ${result.status}`);
    const output = JSON.parse(result.stdout);
    const errors = (output.errors || []).filter((item) => item.severity === "error");
    if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join("\n"));
    const warnings = (output.errors || []).filter((item) => item.severity !== "error" && item.severity !== "info");
    // Catch misspelled output selectors and accidental analysis-only runs.
    let deployable = 0;
    for (const contracts of Object.values(output.contracts || {})) {
        for (const artifact of Object.values(contracts)) {
            if (!artifact.qrvm?.bytecode) throw new Error("Compiler did not return QRVM bytecode");
            if (artifact.qrvm.bytecode.object) deployable++;
        }
    }
    if (deployable < 6) throw new Error("Missing deployable bytecode");
    return {
        output,
        deployable,
        findings: warnings.map((item) => {
            const location = item.sourceLocation;
            const file = location?.file || "<compiler>";
            const fragment = location ? sources[file].content.slice(location.start, location.end) : "";
            return {
                rule: String(item.errorCode || item.type),
                file,
                line: location ? sources[file].content.slice(0, location.start).split("\n").length : 0,
                fingerprint: hash(`${item.message}\n${location?.start ?? -1}\n${fragment}`),
                detail: item.message,
            };
        }),
    };
}

function countByRule(findings) {
    const counts = {};
    for (const finding of findings) counts[finding.rule] = (counts[finding.rule] || 0) + 1;
    return Object.entries(counts)
        .map(([rule, count]) => `${rule} ${count}`)
        .join(", ") || "none";
}

function main() {
    const sourceOnly = process.argv.includes("--source-only");
    const allowances = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
    const sources = sourcesIn();
    const policyFindings = [...hyperionOnlyFindings(), ...sourceFindings(sources)];
    checkAllowlist(policyFindings, allowances.source, "source");
    console.log(
        `Source policy passed: ${Object.keys(sources).length} contract files; reviewed exceptions: ${countByRule(policyFindings)}.`
    );
    if (sourceOnly) {
        console.log("Compiler warning checks skipped (--source-only); they run with the pinned toolchain.");
        return;
    }
    const { ensureCompilerAvailable } = require("./compile-hyperion");
    const { compilerPath } = ensureCompilerAvailable();
    for (const mode of modes) {
        const { deployable, findings } = compileMode(compilerPath, sources, mode);
        checkAllowlist(findings, allowances.warnings, mode.name, () => {});
        console.log(`${mode.name}: ${deployable} bytecode artifacts; reviewed warnings: ${countByRule(findings)}; 0 new.`);
    }
    console.log(`Contract lint passed: ${Object.keys(sources).length} files, ${modes.length} codegen modes.`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    KNOWN_BUG_RULES,
    PRAGMA,
    checkAllowlist,
    compileMode,
    declarations,
    hash,
    hyperionOnlyFindings,
    masked,
    modes,
    sourceFindings,
    sourcesIn,
    uncheckedLowLevelCalls,
};
