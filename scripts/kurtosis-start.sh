#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
package_dir="${QRL_PACKAGE_DIR:-${repo_root}/../qrl-package}"
package_manifest="${package_dir}/kurtosis.yml"
enclave="${KURTOSIS_ENCLAVE:-qrl2-qns}"
args_file="${repo_root}/config/kurtosis-qns.yaml"
local_config="${repo_root}/config/local-qip55.json"
rpc_url="http://127.0.0.1:32002"
node_image="qrl2-qns/go-qrl:pq-precompiles"
qrysm_images=(
    "qrl2-qns/qrysm:beacon-chain-64"
    "qrl2-qns/qrysm:validator-64"
    "qrl2-qns/qrysm:qrl-genesis-generator-64"
)

command -v docker >/dev/null
command -v kurtosis >/dev/null

if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. Start the Docker daemon and retry." >&2
    exit 1
fi

if [[ ! -f "${package_manifest}" ]]; then
    echo "QRL Kurtosis package not found at ${package_dir}" >&2
    exit 1
fi

if ! docker image inspect "${node_image}" >/dev/null 2>&1; then
    "${repo_root}/scripts/build-local-node-image.sh"
fi

for image in "${qrysm_images[@]}"; do
    if ! docker image inspect "${image}" >/dev/null 2>&1; then
        "${repo_root}/scripts/build-local-qrysm-images.sh"
        break
    fi
done

if ! kurtosis enclave inspect "${enclave}" >/dev/null 2>&1; then
    kurtosis run --enclave "${enclave}" "${package_manifest}" --args-file "${args_file}"
fi

node "${repo_root}/scripts/wait-for-rpc.js" "${rpc_url}" 3151908

if [[ ! -f "${local_config}" ]]; then
    cp "${repo_root}/config/local-qip55.example.json" "${local_config}"
fi

echo "Enclave: ${enclave}"
echo "Execution RPC: ${rpc_url}"
echo "Config: ${local_config}"
kurtosis enclave inspect "${enclave}"
