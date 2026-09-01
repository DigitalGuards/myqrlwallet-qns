#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
package_dir="${QRL_PACKAGE_DIR:-${repo_root}/../qrl-package}"
package_manifest="${package_dir}/kurtosis.yml"
node_dir="${GO_QRL_DIR:-${repo_root}/../go-qrl}"
enclave="${KURTOSIS_ENCLAVE:-qrl2-qns-pq}"
args_file="${repo_root}/config/kurtosis-qns.yaml"
local_config="${repo_root}/config/local-qip55.json"
rpc_url="http://127.0.0.1:32002"
node_image="qrl2-qns/go-qrl:pq-precompiles"
qrysm_commit="${QRYSM_COMMIT:-b53fd7c488f3f0d1d4163b270afac1749eed954b}"
generator_commit="${QRL_GENESIS_GENERATOR_COMMIT:-6a11fbcee762af14d188507f071d08ac5782fa69}"
generator_patch="${repo_root}/docker/qrysm/qrl-genesis-generator-qrl2-pq.patch"
beacon_image="qrl2-qns/qrysm:beacon-chain-64"
validator_image="qrl2-qns/qrysm:validator-64"
generator_image="qrl2-qns/qrysm:qrl-genesis-generator-64"
force_rebuild="${QNS_FORCE_REBUILD:-0}"
runtime_dir="${TMPDIR:-/tmp}/myqrlwallet-qns-${UID}/${enclave}"
proxy_pid_file="${runtime_dir}/rpc-proxy.pid"
proxy_log_file="${runtime_dir}/rpc-proxy.log"
proxy_unit="myqrlwallet-qns-rpc-${enclave}.service"
proxy_description="MyQRLWallet QNS RPC proxy for ${enclave}"

command -v docker >/dev/null
command -v git >/dev/null
command -v kurtosis >/dev/null
command -v sha256sum >/dev/null
command -v socat >/dev/null

if [[ ! "${enclave}" =~ ^[[:alnum:]][[:alnum:]_-]*$ ]]; then
    echo "KURTOSIS_ENCLAVE must start with an alphanumeric character and contain only alphanumerics, underscores, or hyphens." >&2
    exit 1
fi

if [[ ! -f "${generator_patch}" ]]; then
    echo "QRL2 genesis-generator patch not found at ${generator_patch}" >&2
    exit 1
fi
generator_patch_sha="$(sha256sum "${generator_patch}" | awk '{print $1}')"

case "${force_rebuild}" in
    0|1) ;;
    *)
        echo "QNS_FORCE_REBUILD must be 0 or 1" >&2
        exit 1
        ;;
esac

if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. Start the Docker daemon and retry." >&2
    exit 1
fi

if [[ ! -f "${package_manifest}" ]]; then
    echo "QRL Kurtosis package not found at ${package_dir}" >&2
    exit 1
fi

if [[ ! -f "${node_dir}/Dockerfile" ]]; then
    echo "go-qrl checkout not found at ${node_dir}" >&2
    exit 1
fi

node_source_fingerprint() {
    (
        cd "${node_dir}"
        while IFS= read -r -d '' source_file; do
            printf '%s\0' "${source_file}"
            if [[ -L "${source_file}" ]]; then
                printf 'symlink\0%s\0' "$(readlink "${source_file}")"
            elif [[ -f "${source_file}" ]]; then
                printf 'file\0%s\0' "$(stat -c '%a' "${source_file}")"
                printf '%s\0' "$(sha256sum -- "${source_file}" | awk '{print $1}')"
            else
                printf 'missing\0'
            fi
        done < <(git ls-files --cached --others --exclude-standard -z | LC_ALL=C sort -z)
    ) | sha256sum | awk '{print $1}'
}

node_revision="$(git -C "${node_dir}" rev-parse HEAD)"
node_source_state="clean"
node_content_sha="$(node_source_fingerprint)"
if [[ -n "$(git -C "${node_dir}" status --porcelain=v1 --untracked-files=all)" ]]; then
    node_source_state="dirty"
fi

image_label() {
    local image="$1"
    local label="$2"
    docker image inspect "${image}" \
        --format "{{ index .Config.Labels \"${label}\" }}" 2>/dev/null || true
}

image_id() {
    docker image inspect "$1" --format '{{.Id}}' 2>/dev/null || true
}

node_image_is_current() {
    [[ "$(image_label "${node_image}" org.opencontainers.image.revision)" == "${node_revision}" ]] &&
        [[ "$(image_label "${node_image}" org.opencontainers.image.source-state)" == "${node_source_state}" ]] &&
        [[ "$(image_label "${node_image}" org.qrl.qns.source-content-sha256)" == "${node_content_sha}" ]]
}

qrysm_image_is_current() {
    local image="$1"
    local revision="$2"
    [[ "$(image_label "${image}" org.opencontainers.image.revision)" == "${revision}" ]]
}

generator_image_is_current() {
    [[ "$(image_label "${generator_image}" org.opencontainers.image.revision)" == "${generator_commit}" ]] &&
        [[ "$(image_label "${generator_image}" org.qrl.qns.source-patch-sha256)" == "${generator_patch_sha}" ]] &&
        [[ "$(image_label "${generator_image}" org.qrl.qns.qrl2-pq-precompiles-time)" == "0" ]]
}

ensure_node_image() {
    if [[ "${force_rebuild}" == "1" ]] || ! node_image_is_current; then
        echo "Building go-qrl image for ${node_revision} (${node_source_state}, ${node_content_sha})." >&2
        "${repo_root}/scripts/build-local-node-image.sh"
    fi
}

ensure_qrysm_images() {
    if [[ "${force_rebuild}" == "1" ]] ||
        ! qrysm_image_is_current "${beacon_image}" "${qrysm_commit}" ||
        ! qrysm_image_is_current "${validator_image}" "${qrysm_commit}" ||
        ! generator_image_is_current; then
        "${repo_root}/scripts/build-local-qrysm-images.sh"
    fi
}

service_container_id() {
    local service="$1"
    docker ps \
        --filter "label=kurtosis_enclave_name=${enclave}" \
        --filter "label=kurtosis_service_name=${service}" \
        --format '{{.ID}}' | head -n 1
}

verify_running_service_image() {
    local service="$1"
    local expected_image="$2"
    local container_id
    local running_image_id
    local expected_image_id

    container_id="$(service_container_id "${service}")"
    if [[ -z "${container_id}" ]]; then
        echo "Running container not found for Kurtosis service ${service}" >&2
        return 1
    fi

    running_image_id="$(docker inspect "${container_id}" --format '{{.Image}}')"
    expected_image_id="$(image_id "${expected_image}")"
    if [[ -z "${expected_image_id}" || "${running_image_id}" != "${expected_image_id}" ]]; then
        echo "Kurtosis service ${service} is not using the current local image ${expected_image}" >&2
        return 1
    fi
}

verify_running_enclave_provenance() {
    if ! node_image_is_current; then
        echo "Local go-qrl image does not match source commit ${node_revision} and content ${node_content_sha}." >&2
        return 1
    fi
    if ! qrysm_image_is_current "${beacon_image}" "${qrysm_commit}" ||
        ! qrysm_image_is_current "${validator_image}" "${qrysm_commit}" ||
        ! generator_image_is_current; then
        echo "Local Qrysm images do not match the pinned source revisions." >&2
        return 1
    fi

    verify_running_service_image "el-1-gqrl-qrysm" "${node_image}"
    verify_running_service_image "cl-1-qrysm-gqrl" "${beacon_image}"
    verify_running_service_image "vc-1-gqrl-qrysm" "${validator_image}"
}

verify_running_enclave_bindings() {
    local container_id
    local container_name
    local port_bindings
    local port
    local host_ip
    local host_port
    local -a container_ids

    mapfile -t container_ids < <(
        docker ps \
            --filter "label=kurtosis_enclave_name=${enclave}" \
            --format '{{.ID}}'
    )
    if [[ "${#container_ids[@]}" -eq 0 ]]; then
        echo "No running service containers were found for bind verification." >&2
        return 1
    fi

    for container_id in "${container_ids[@]}"; do
        container_name="$(docker inspect "${container_id}" --format '{{.Name}}')"
        port_bindings="$(docker inspect "${container_id}" --format '{{json .NetworkSettings.Ports}}')"
        while IFS=$'\t' read -r port host_ip host_port; do
            [[ -n "${host_port}" ]] || continue
            if [[ "${host_ip}" != "127.0.0.1" && "${host_ip}" != "::1" ]]; then
                echo "Service ${container_name#/} has a non-loopback host binding for ${port}: ${host_ip}:${host_port}" >&2
                echo "Observed Docker bindings: ${port_bindings}" >&2
                return 1
            fi
        done < <(
            docker inspect "${container_id}" \
                --format '{{range $port, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{printf "%s\t%s\t%s\n" $port .HostIp .HostPort}}{{end}}{{end}}'
        )
    done
}

proxy_systemd_is_current() {
    local description
    local exec_start
    local destination_ip="$1"
    command -v systemctl >/dev/null || return 1
    systemctl --user is-active --quiet "${proxy_unit}" || return 1
    description="$(systemctl --user show "${proxy_unit}" --property=Description --value 2>/dev/null || true)"
    exec_start="$(systemctl --user show "${proxy_unit}" --property=ExecStart --value 2>/dev/null || true)"
    [[ "${description}" == "${proxy_description}" ]] &&
        [[ "${exec_start}" == *"TCP-LISTEN:32002,bind=127.0.0.1"* ]] &&
        [[ "${exec_start}" == *"TCP:${destination_ip}:8545"* ]]
}

proxy_pid_is_current() {
    local pid
    local command_line
    local destination_ip="$1"
    [[ -f "${proxy_pid_file}" ]] || return 1
    pid="$(<"${proxy_pid_file}")"
    [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
    kill -0 "${pid}" 2>/dev/null || return 1
    command_line="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
    [[ "${command_line}" == *"TCP-LISTEN:32002,bind=127.0.0.1"* ]] &&
        [[ "${command_line}" == *"TCP:${destination_ip}:8545"* ]]
}

stop_rpc_proxy() {
    local pid
    local command_line
    local description

    if command -v systemctl >/dev/null && systemctl --user cat "${proxy_unit}" >/dev/null 2>&1; then
        description="$(systemctl --user show "${proxy_unit}" --property=Description --value 2>/dev/null || true)"
        if [[ "${description}" != "${proxy_description}" ]]; then
            echo "Refusing to stop ${proxy_unit}: its description does not identify the QNS RPC proxy." >&2
            return 1
        fi
        systemctl --user stop "${proxy_unit}"
        systemctl --user reset-failed "${proxy_unit}" >/dev/null 2>&1 || true
    fi

    [[ -f "${proxy_pid_file}" ]] || return 0
    pid="$(<"${proxy_pid_file}")"
    if [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null; then
        command_line="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
        if [[ "${command_line}" == *"TCP-LISTEN:32002,bind=127.0.0.1"* ]]; then
            kill "${pid}"
            for _ in {1..50}; do
                if ! kill -0 "${pid}" 2>/dev/null; then
                    break
                fi
                sleep 0.1
            done
            if kill -0 "${pid}" 2>/dev/null; then
                echo "The QNS RPC proxy PID ${pid} did not stop." >&2
                return 1
            fi
        else
            echo "Refusing to stop PID ${pid}: it is not the QNS RPC proxy." >&2
            return 1
        fi
    fi
    rm -f -- "${proxy_pid_file}"
}

start_rpc_proxy() {
    local container_id
    local destination_ip
    local proxy_pid
    local socat_bin
    container_id="$(service_container_id "el-1-gqrl-qrysm")"
    destination_ip="$(docker inspect "${container_id}" \
        --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')"
    if [[ -z "${destination_ip}" ]]; then
        echo "Execution service has no Docker network address for the RPC proxy." >&2
        return 1
    fi
    if proxy_systemd_is_current "${destination_ip}" || proxy_pid_is_current "${destination_ip}"; then
        return 0
    fi
    stop_rpc_proxy
    mkdir -p -- "${runtime_dir}"
    chmod 700 "${runtime_dir}"
    socat_bin="$(command -v socat)"

    if command -v systemd-run >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
        systemd-run --user --quiet --collect \
            --unit="${proxy_unit}" \
            --description="${proxy_description}" \
            --property=Restart=on-failure \
            --property=RestartSec=1s \
            -- "${socat_bin}" \
            "TCP-LISTEN:32002,bind=127.0.0.1,reuseaddr,fork" \
            "TCP:${destination_ip}:8545"
        for _ in {1..50}; do
            if proxy_systemd_is_current "${destination_ip}"; then
                return 0
            fi
            sleep 0.1
        done
        echo "The systemd-managed loopback RPC proxy failed to start." >&2
        systemctl --user status "${proxy_unit}" --no-pager >&2 || true
        return 1
    fi

    nohup setsid "${socat_bin}" \
        "TCP-LISTEN:32002,bind=127.0.0.1,reuseaddr,fork" \
        "TCP:${destination_ip}:8545" \
        </dev/null >>"${proxy_log_file}" 2>&1 &
    proxy_pid=$!
    printf '%s\n' "${proxy_pid}" > "${proxy_pid_file}"
    if ! proxy_pid_is_current "${destination_ip}"; then
        echo "The loopback RPC proxy failed to start. See ${proxy_log_file}" >&2
        return 1
    fi
}

finish_start() {
    start_rpc_proxy
    node "${repo_root}/scripts/wait-for-rpc.js" "${rpc_url}" 3151908

    if [[ ! -f "${local_config}" ]]; then
        cp "${repo_root}/config/local-qip55.example.json" "${local_config}"
    fi

    echo "Enclave: ${enclave}"
    echo "Execution RPC client URL: ${rpc_url}"
    echo "Config: ${local_config}"
    kurtosis enclave inspect "${enclave}"
}

enclave_inspect=""
if enclave_inspect="$(kurtosis enclave inspect "${enclave}" 2>/dev/null)"; then
    enclave_status="$(sed -n 's/^Status:[[:space:]]*//p' <<< "${enclave_inspect}")"
    if [[ "${enclave_status}" != "RUNNING" ]]; then
        echo "Enclave ${enclave} exists with status ${enclave_status:-unknown}." >&2
        echo "Kurtosis cannot resume a stopped enclave. Remove it deliberately or choose a new KURTOSIS_ENCLAVE name." >&2
        exit 1
    fi
    if [[ "${force_rebuild}" == "1" ]]; then
        echo "QNS_FORCE_REBUILD=1 cannot replace images in a running enclave. Recreate the enclave deliberately." >&2
        exit 1
    fi
    verify_running_enclave_provenance
    verify_running_enclave_bindings
    finish_start
    exit 0
fi

ensure_node_image
ensure_qrysm_images

cleanup_new_enclave_on_error() {
    local status=$?
    trap - ERR
    stop_rpc_proxy || true
    kurtosis enclave stop "${enclave}" >/dev/null 2>&1 || true
    echo "Stopped the new enclave ${enclave} after a startup failure." >&2
    exit "${status}"
}
trap cleanup_new_enclave_on_error ERR

kurtosis run --enclave "${enclave}" "${package_manifest}" --args-file "${args_file}"

if ! verify_running_enclave_provenance || ! verify_running_enclave_bindings; then
    echo "The new enclave failed image or bind verification and will be stopped." >&2
    kurtosis enclave stop "${enclave}" || true
    exit 1
fi

finish_start
trap - ERR
