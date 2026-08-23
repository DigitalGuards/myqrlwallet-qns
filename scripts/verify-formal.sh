#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
compiler="${HYPERION_FORMAL_COMPILER:-${repo_root}/../hyperion/build-formal/hypc/hypc}"

command -v rg >/dev/null

if [[ ! -x "${compiler}" ]]; then
    echo "Proof-capable Hyperion compiler not found: ${compiler}" >&2
    echo "Build Hyperion with USE_Z3=ON or set HYPERION_FORMAL_COMPILER." >&2
    exit 1
fi

if [[ -n "${HYPERION_Z3_LIBRARY_DIR:-}" ]]; then
    export LD_LIBRARY_PATH="${HYPERION_Z3_LIBRARY_DIR}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

run_proof() {
    local label="$1"
    local source="$2"
    local contract="$3"
    local expected_safe="$4"
    local proof_output
    local safe_count

    proof_output="$(mktemp)"
    trap 'rm -f "${proof_output}"' RETURN

    echo "Formal proof: ${label}"
    (
        cd "${repo_root}"
        "${compiler}" \
            --base-path=. \
            --allow-paths=. \
            "--model-checker-contracts=${source}:${contract}" \
            --model-checker-engine=chc \
            --model-checker-solvers=z3 \
            --model-checker-targets=assert,underflow,overflow,divByZero,popEmptyArray,outOfBounds,balance \
            --model-checker-show-proved-safe \
            --model-checker-show-unproved \
            --model-checker-show-unsupported \
            "${source}"
    ) 2>&1 | tee "${proof_output}"

    if rg -q \
        '^Warning: (CHC|BMC):|Solver .*not available|analysis was not possible|Assertion checker does not yet implement' \
        "${proof_output}"; then
        echo "Formal proof failed: ${label} produced an unsafe or unproved target." >&2
        exit 1
    fi

    safe_count="$(rg -c 'Info: CHC: .* check is safe!' "${proof_output}" || true)"
    if [[ "${safe_count}" != "${expected_safe}" ]]; then
        echo \
            "Formal proof failed: ${label} proved ${safe_count} targets; expected ${expected_safe}." \
            >&2
        exit 1
    fi

    echo "Formal proof passed: ${label} (${safe_count} safe targets)"
    rm -f "${proof_output}"
    trap - RETURN
}

run_proof \
    "cryptographic boundary and resolver capabilities" \
    "test/formal/QNSSecurityProperties.hyp" \
    "QNSSecurityProperties" \
    26

run_proof \
    "64-byte reverse-index arithmetic" \
    "test/formal/QNSReverseSafetyProperties.hyp" \
    "QNSReverseSafetyProperties" \
    10

echo "Formal verification passed: 36 CHC targets proved safe."
