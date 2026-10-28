function printError(prefix, error, log = console.error) {
    log(prefix, error?.message ?? String(error));
    const seen = new Set();
    const details = (value) => {
        if (!value || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        for (const key of ["reason", "innerError", "cause", "data"]) {
            if (value[key] !== undefined) {
                log(`${key}:`, value[key]);
                details(value[key]);
            }
        }
    };
    details(error);
}

module.exports = { printError };
