// Sync contracts/solidity/**/*.sol to contracts/hyperion/**/*.hyp, applying
// three Solidity -> Hyperion dialect translations (pragma, unit denominations,
// address literals). Preserves the nested directory structure so relative
// imports keep working after rewriting.
//
// Adapted from ../../QuantaPool/scripts/sync-hyperion.js (GPL-3.0).
// Differences: walks nested dirs rather than a flat layout, and does not
// rewrite imports because we keep the same relative structure on both sides.

const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const solidityRoot = path.join(repoRoot, "contracts", "solidity");
const hyperionRoot = path.join(repoRoot, "contracts", "hyperion");

// Resolve remapped import prefixes to the corresponding hyperion target path.
// This matches the foundry.toml remappings applied for the Solidity build.
const REMAPS = [
    { from: "@openzeppelin/contracts/", toUnder: "vendored/openzeppelin/" },
    { from: "@ensdomains/", toUnder: "vendored/" },
];

/// Compute a relative import path from `fromRelPath` (dir) to `toRelPath` (file),
/// ensuring the result is prefixed with `./` when it stays in the same dir.
function relImport(fromDirRel, toRel) {
    let rel = path.posix.relative(fromDirRel.split(path.sep).join("/"),
                                  toRel.split(path.sep).join("/"));
    if (!rel.startsWith(".")) rel = "./" + rel;
    return rel;
}

function toHyperionSource(source, relPath) {
    const pragmaUpdated = source.replace(
        /^pragma solidity\s+[^;]+;/m,
        "pragma hyperion >=0.0;"
    );

    if (pragmaUpdated === source) {
        throw new Error(`No Solidity pragma found in ${relPath}`);
    }

    // Rewrite remapped import prefixes to relative .hyp paths so hypc can
    // resolve them with just --base-path, no fragile remapping args.
    const fromDirRel = path.dirname(relPath);
    let remapUpdated = pragmaUpdated;
    for (const { from, toUnder } of REMAPS) {
        const re = new RegExp(
            `(import\\s+[^'"]*["'])${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^"']+)(["'];)`,
            "g"
        );
        remapUpdated = remapUpdated.replace(re, (_m, pre, tail, post) => {
            const target = path.posix.join(toUnder, tail);
            return pre + relImport(fromDirRel, target) + post;
        });
    }

    // Remaining imports: flip .sol -> .hyp extension.
    const importsUpdated = remapUpdated.replace(
        /(import\s+[^'"]*["'][^'"]+)\.sol(["'];)/g,
        "$1.hyp$2"
    );

    // Translate unit suffixes: 1 ether (sol) == 1 quanta (hyp) == 1e18 planck.
    const denominationsUpdated = importsUpdated
        .replace(/(\b\d[\d_]*(?:\.\d+)?\s+)ether\b/g, "$1quanta")
        .replace(/(\b\d[\d_]*(?:\.\d+)?\s+)gwei\b/g, "$1shor")
        .replace(/(\b\d[\d_]*(?:\.\d+)?\s+)wei\b/g, "$1planck");

    // Translate exactly-40-hex 0x literals to Q-prefix. Avoids touching
    // bytes32 / bytes4 / numeric literals.
    const addressesUpdated = denominationsUpdated.replace(
        /\b0x([0-9a-fA-F]{40})\b/g,
        "Q$1"
    );

    const banner =
        `// Generated from contracts/solidity/${relPath} by scripts/sync-hyperion.js.\n` +
        "// Edit the Solidity source, then re-run this script.\n";

    if (addressesUpdated.startsWith("// SPDX-License-Identifier:")) {
        const firstNewline = addressesUpdated.indexOf("\n");
        return (
            addressesUpdated.slice(0, firstNewline + 1) +
            banner +
            addressesUpdated.slice(firstNewline + 1)
        );
    }
    return banner + addressesUpdated;
}

function walkSol(dir, visit, rel = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const relPath = path.join(rel, entry.name);
        if (entry.isDirectory()) {
            walkSol(abs, visit, relPath);
        } else if (entry.isFile() && entry.name.endsWith(".sol")) {
            visit(abs, relPath);
        }
    }
}

function clearHyperionTree() {
    if (!fs.existsSync(hyperionRoot)) {
        fs.mkdirSync(hyperionRoot, { recursive: true });
        return;
    }
    // Remove .hyp files under hyperionRoot but keep any README.md / hand-written.
    const drop = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                drop(abs);
                // Remove empty dirs so we don't accumulate cruft.
                if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
            } else if (entry.name.endsWith(".hyp")) {
                fs.rmSync(abs);
            }
        }
    };
    drop(hyperionRoot);
}

function syncHyperionSources() {
    if (!fs.existsSync(solidityRoot)) {
        throw new Error(`Missing ${solidityRoot}`);
    }
    clearHyperionTree();

    const synced = [];
    walkSol(solidityRoot, (absPath, relPath) => {
        const source = fs.readFileSync(absPath, "utf8");
        const converted = toHyperionSource(source, relPath);
        const targetRel = relPath.replace(/\.sol$/, ".hyp");
        const targetAbs = path.join(hyperionRoot, targetRel);
        fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
        fs.writeFileSync(targetAbs, converted);
        synced.push(targetRel);
        console.log(`sync ${targetRel}`);
    });

    if (synced.length === 0) {
        throw new Error("No Solidity sources found to sync.");
    }
    return synced;
}

if (require.main === module) {
    try {
        const synced = syncHyperionSources();
        console.log(`\nSynced ${synced.length} file(s) to contracts/hyperion/`);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = { syncHyperionSources };
