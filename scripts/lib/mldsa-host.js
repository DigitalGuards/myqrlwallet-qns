// Local ML-DSA-87 verifier for the test-only slot 3 host adapter
// (test/hyperion/host/mldsa.inc). The adapter sends the complete raw
// precompile frame, digest || publicKey || signature || uint8(contextLength)
// || context, behind a 4-byte big-endian length. The reply is one byte: 1 for
// a valid signature, 0 otherwise. Malformed frames, including the one-byte
// frame Hyperion emits for wrong signature, key or context lengths, are 0.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { cryptoSignVerify } = require("@theqrl/mldsa87");

const DIGEST_BYTES = 64;
const PUBLIC_KEY_BYTES = 2592;
const SIGNATURE_BYTES = 4627;
const CONTEXT_LENGTH_OFFSET = DIGEST_BYTES + PUBLIC_KEY_BYTES + SIGNATURE_BYTES;

function verifyFrame(frame) {
    if (frame.length <= CONTEXT_LENGTH_OFFSET) return false;
    const contextLength = frame[CONTEXT_LENGTH_OFFSET];
    if (frame.length !== CONTEXT_LENGTH_OFFSET + 1 + contextLength) return false;
    const digest = frame.subarray(0, DIGEST_BYTES);
    const publicKey = frame.subarray(DIGEST_BYTES, DIGEST_BYTES + PUBLIC_KEY_BYTES);
    const signature = frame.subarray(DIGEST_BYTES + PUBLIC_KEY_BYTES, CONTEXT_LENGTH_OFFSET);
    const context = frame.subarray(CONTEXT_LENGTH_OFFSET + 1);
    return cryptoSignVerify(signature, digest, publicKey, context) === true;
}

function serve(socketPath) {
    const stats = { requests: 0, accepted: 0 };
    const server = net.createServer((socket) => {
        let data = Buffer.alloc(0);
        socket.on("data", (chunk) => {
            data = Buffer.concat([data, chunk]);
            if (data.length < 4) return;
            const expected = data.readUInt32BE(0) + 4;
            if (data.length < expected) return;
            if (data.length !== expected) {
                socket.destroy();
                return;
            }
            let verdict;
            try {
                verdict = verifyFrame(data.subarray(4));
            } catch (error) {
                // A thrown verifier error is not a verdict. Closing without a
                // reply makes the host adapter abort the test run.
                console.error(`ML-DSA verifier error: ${error.message}`);
                socket.destroy();
                return;
            }
            stats.requests += 1;
            if (verdict) stats.accepted += 1;
            socket.end(Buffer.from([verdict ? 1 : 0]));
        });
    });
    server.listen(socketPath, () => process.send?.({ type: "ready" }));
    process.on("message", (message) => {
        if (message?.type === "stats") process.send?.({ type: "stats", ...stats });
    });
    process.on("disconnect", () => server.close());
}

// Starts the verifier in a child process so callers may block on spawnSync
// while the adapter connects. Resolves to { socketPath, stats(), stop() }.
async function startVerifier() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qns-mldsa-"));
    const socketPath = path.join(directory, "verify.sock");
    const child = fork(__filename, [socketPath], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    await new Promise((resolve, reject) => {
        child.once("message", (message) =>
            message?.type === "ready" ? resolve() : reject(new Error("verifier did not start"))
        );
        child.once("exit", (code) => reject(new Error(`verifier exited with ${code}`)));
    });
    const stats = () =>
        new Promise((resolve, reject) => {
            child.once("message", (message) =>
                message?.type === "stats" ? resolve(message) : reject(new Error("bad stats reply"))
            );
            child.send({ type: "stats" });
        });
    const stop = () => {
        if (child.connected) child.disconnect();
        child.kill();
        fs.rmSync(directory, { force: true, recursive: true });
    };
    return { socketPath, stats, stop };
}

if (require.main === module) serve(process.argv[2]);

module.exports = { startVerifier, verifyFrame };
