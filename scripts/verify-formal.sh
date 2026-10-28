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

all_targets="assert,underflow,overflow,divByZero,popEmptyArray,outOfBounds,balance"

# Runs the model checker on one harness contract. Optional arguments select
# the engine (chc or bmc), the target list, and a per-query solver timeout in
# milliseconds. BMC analyses each function from an arbitrary storage state; the
# BMC harnesses are loop-free, so their results are not bounded by unrolling.
run_model_checker() {
    local source="$1"
    local contract="$2"
    local engine="$3"
    local targets="$4"
    local timeout_ms="$5"
    local output="$6"
    local timeout_args=()
    if [[ -n "${timeout_ms}" ]]; then
        timeout_args=("--model-checker-timeout=${timeout_ms}")
    fi
    (
        cd "${repo_root}"
        "${compiler}" \
            --base-path=. \
            --allow-paths=. \
            "--model-checker-contracts=${source}:${contract}" \
            "--model-checker-engine=${engine}" \
            --model-checker-solvers=z3 \
            "--model-checker-targets=${targets}" \
            --model-checker-show-proved-safe \
            --model-checker-show-unproved \
            --model-checker-show-unsupported \
            "${timeout_args[@]}" \
            "${source}"
    ) 2>&1 | tee "${output}"
}

run_proof() {
    local label="$1"
    local source="$2"
    local contract="$3"
    local expected_safe="$4"
    local engine="${5:-chc}"
    local targets="${6:-${all_targets}}"
    local timeout_ms="${7:-}"
    local engine_label="${engine^^}"
    local proof_output
    local safe_count

    proof_output="$(mktemp)"
    trap 'rm -f "${proof_output}"' RETURN

    echo "Formal proof: ${label}"
    run_model_checker "${source}" "${contract}" "${engine}" "${targets}" "${timeout_ms}" "${proof_output}"

    if rg -q \
        '^Warning: (CHC|BMC):|Solver .*not available|analysis was not possible|does not yet implement' \
        "${proof_output}"; then
        echo "Formal proof failed: ${label} produced an unsafe or unproved target." >&2
        exit 1
    fi

    safe_count="$(rg -c "Info: ${engine_label}: .* check is safe!" "${proof_output}" || true)"
    if [[ "${safe_count}" != "${expected_safe}" ]]; then
        echo \
            "Formal proof failed: ${label} proved ${safe_count} targets; expected ${expected_safe}." \
            >&2
        exit 1
    fi

    echo "Formal proof passed: ${label} (${safe_count} safe ${engine_label} targets)"
    rm -f "${proof_output}"
    trap - RETURN
}

# Anti-vacuity: every witness ends in assert(false) after a production path, and
# the model checker must report each one as reachable.
run_reachability() {
    local label="$1"
    local source="$2"
    local contract="$3"
    local expected_reachable="$4"
    local witness_output
    local reachable_count

    witness_output="$(mktemp)"
    trap 'rm -f "${witness_output}"' RETURN

    echo "Reachability witnesses: ${label}"
    run_model_checker "${source}" "${contract}" bmc assert 60000 "${witness_output}"

    if rg -q \
        'Solver .*not available|analysis was not possible|does not yet implement|might happen|check is safe' \
        "${witness_output}"; then
        echo "Reachability failed: ${label} has a witness the checker did not reach." >&2
        exit 1
    fi

    reachable_count="$(rg -c '^Warning: BMC: Assertion violation happens here' "${witness_output}" || true)"
    if [[ "${reachable_count}" != "${expected_reachable}" ]]; then
        echo \
            "Reachability failed: ${label} reached ${reachable_count} witnesses; expected ${expected_reachable}." \
            >&2
        exit 1
    fi

    echo "Reachability passed: ${label} (${reachable_count} witnesses reached)"
    rm -f "${witness_output}"
    trap - RETURN
}

# The CHC counts below are name-blind, so first require every named property
# to exist in its file. This catches a deleted or renamed security property
# being silently replaced by compiler-generated arithmetic targets.
require_properties() {
    local source="$1"
    shift
    local name
    for name in "$@"; do
        if ! rg -q "function ${name}\\(" "${repo_root}/${source}"; then
            echo "Formal gate failed: ${source} is missing property ${name}." >&2
            exit 1
        fi
    done
}

require_properties "test/formal/QNSSecurityProperties.hyp" \
    proveMalformedDigestRejected \
    proveExactDigestDispatch \
    proveQNSContext \
    proveCryptoDeterminism \
    proveOwnerOnlyPolicy \
    proveUnauthorizedOwnerOnlyTransition \
    proveTrustedRegistrarScope \
    proveTrustedRegistrarCannotMutateOwnerOnlyRecord

require_properties "test/formal/QNSReverseSafetyProperties.hyp" \
    provePairBounds \
    provePairInjective \
    proveNibbleBounds

require_properties "test/formal/QNSRegistryProperties.hyp" \
    proveSetOwnerAuthority \
    proveSetOwnerFrame \
    proveSubnodeAuthority \
    proveResolverAndTtlAuthority \
    proveRegistryOwnedNodeIsFrozen \
    proveOwnerViews

require_properties "test/formal/QNSControllableProperties.hyp" \
    proveSetControllerEffect \
    proveTransferOwnershipEffect \
    proveRenounceEffect

require_properties "test/formal/QNSResolverVersionProperties.hyp" \
    proveClearRecordsBumpsVersion

require_properties "test/formal/QNSRegistryReachability.hyp" \
    reachSetOwner \
    reachSetOwnerFrame \
    reachSetSubnodeOwner \
    reachResolverAndTtl \
    reachFrozenNodePreconditions \
    reachOwnerViews

require_properties "test/formal/QNSControllableReachability.hyp" \
    reachSetController \
    reachTransferOwnership \
    reachRenounce

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

run_proof \
    "registry authority and frame conditions" \
    "test/formal/QNSRegistryProperties.hyp" \
    "QNSRegistryProperties" \
    17 \
    bmc \
    "${all_targets}" \
    60000

run_reachability \
    "registry property paths" \
    "test/formal/QNSRegistryReachability.hyp" \
    "QNSRegistryReachability" \
    6

run_proof \
    "Controllable and Ownable effects" \
    "test/formal/QNSControllableProperties.hyp" \
    "QNSControllableProperties" \
    7 \
    bmc \
    "${all_targets}" \
    60000

run_reachability \
    "Controllable property paths" \
    "test/formal/QNSControllableReachability.hyp" \
    "QNSControllableReachability" \
    3

# Assertion targets only: the version counter and the property's own sum use
# checked uint64 arithmetic, which reverts on overflow after 2^64 clears.
run_proof \
    "resolver record version" \
    "test/formal/QNSResolverVersionProperties.hyp" \
    "QNSResolverVersionProperties" \
    1 \
    chc \
    assert \
    60000

echo "Formal verification passed: 37 CHC and 24 BMC targets proved safe; 9 reachability witnesses reached."
