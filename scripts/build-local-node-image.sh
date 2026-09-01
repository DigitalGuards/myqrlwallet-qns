#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
node_dir="${GO_QRL_DIR:-${repo_root}/../go-qrl}"
image="qrl2-qns/go-qrl:pq-precompiles"

command -v docker >/dev/null
command -v git >/dev/null
command -v rg >/dev/null
command -v sha256sum >/dev/null

if [[ ! -f "${node_dir}/Dockerfile" ]]; then
    echo "go-qrl checkout not found at ${node_dir}" >&2
    exit 1
fi

if ! rg -q "type shake256hash struct" "${node_dir}/core/vm/contracts.go"; then
    echo "go-qrl checkout does not contain the SHAKE256 precompile" >&2
    exit 1
fi

if ! rg -q "type mldsa87Verify struct" "${node_dir}/core/vm/contracts.go"; then
    echo "go-qrl checkout does not contain the ML-DSA-87 precompile" >&2
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
node_fingerprint="${node_revision}-${node_content_sha:0:12}"

build_args=(
    --tag "${image}"
    --build-arg "COMMIT=${node_fingerprint}"
    --label "org.opencontainers.image.revision=${node_revision}"
    --label "org.opencontainers.image.source-state=${node_source_state}"
    --label "org.qrl.qns.source-content-sha256=${node_content_sha}"
)
if [[ -n "${QNS_DOCKER_CGROUP_PARENT:-}" ]]; then
    build_args+=(--cgroup-parent "${QNS_DOCKER_CGROUP_PARENT}")
fi

docker build "${build_args[@]}" "${node_dir}"
if [[ "$(node_source_fingerprint)" != "${node_content_sha}" ]]; then
    echo "go-qrl source changed while the image was building; refusing the resulting image provenance." >&2
    exit 1
fi
echo "Built ${image} from go-qrl ${node_fingerprint}"
