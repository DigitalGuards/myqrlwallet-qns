// Batch client for test/hyperion/host/qrvm-driver.cpp. The fuzzer generates
// every command up front (the reference model never needs VM feedback), runs
// one driver process per batch and parses the replies in order.
const { spawnSync } = require("node:child_process");

const STATUS = Object.freeze({ success: 0, failure: 1, revert: 2 });

function command(kind, ...words) {
    return [kind, ...words.map((word) => (word === "" || word === undefined ? "-" : word))].join(" ");
}

function parseReplies(commands, stdout) {
    const lines = stdout.split("\n");
    let cursor = 0;
    const next = () => {
        if (cursor >= lines.length) throw new Error("driver output ended early");
        return lines[cursor++];
    };
    const hexOrEmpty = (word) => (word === "-" ? Buffer.alloc(0) : Buffer.from(word, "hex"));
    const replies = [];
    for (const text of commands) {
        const kind = text.slice(0, text.indexOf(" ") < 0 ? text.length : text.indexOf(" "));
        if (kind === "create" || kind === "call") {
            const [tag, status, created, output, count] = next().split(" ");
            if (tag !== "R") throw new Error(`unexpected driver reply for ${kind}`);
            const logs = [];
            for (let i = 0; i < Number(count); i++) {
                const [logTag, creator, topics, data] = next().split(" ");
                if (logTag !== "L") throw new Error("missing log line");
                logs.push({
                    address: creator,
                    topics: topics === "-" ? [] : topics.split(",").map((topic) => Buffer.from(topic, "hex")),
                    data: hexOrEmpty(data),
                });
            }
            replies.push({
                kind,
                status: Number(status),
                created: created === "-" ? null : created,
                output: hexOrEmpty(output),
                logs,
            });
        } else if (kind === "view") {
            const [tag, status, output] = next().split(" ");
            if (tag !== "V") throw new Error("unexpected driver reply for view");
            replies.push({ kind, status: Number(status), output: hexOrEmpty(output) });
        } else if (kind === "observe") {
            const [tag, digest] = next().split(" ");
            if (tag !== "O") throw new Error("unexpected driver reply for observe");
            replies.push({ kind, digest });
        } else if (kind === "observe-verbose") {
            replies.push({ kind, views: null });
        } else if (kind === "viewlist" || kind === "reset" || kind === "snapshot" || kind === "restore") {
            const reply = next();
            if (!reply.startsWith("ok")) throw new Error(`unexpected driver reply for ${kind}: ${reply}`);
            replies.push({ kind });
        } else if (/^[0-9a-f]{128} /.test(text)) {
            // A view-list entry consumes no reply of its own.
            continue;
        } else {
            throw new Error(`unknown driver command ${kind}`);
        }
        if (kind === "observe-verbose") {
            const views = [];
            while (cursor < lines.length && lines[cursor].startsWith("V ")) {
                const [, status, output] = lines[cursor++].split(" ");
                views.push({ status: Number(status), output: hexOrEmpty(output) });
            }
            replies[replies.length - 1].views = views;
        }
    }
    return replies;
}

function runDriver({ driver, vm, env = process.env }, commands) {
    const result = spawnSync(driver, [vm], {
        input: commands.join("\n") + "\n",
        encoding: "utf8",
        env,
        maxBuffer: 1024 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`qns-qrvm-driver exited with ${result.status} ${result.signal || ""}: ${result.stderr}`);
    }
    return parseReplies(commands, result.stdout);
}

module.exports = { STATUS, command, parseReplies, runDriver };
