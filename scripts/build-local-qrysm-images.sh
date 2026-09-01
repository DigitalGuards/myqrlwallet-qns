#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
dockerfile="${repo_root}/docker/qrysm/Dockerfile"

qrysm_repository="${QRYSM_REPOSITORY:-https://github.com/cyyber/qrysm.git}"
qrysm_commit="${QRYSM_COMMIT:-b53fd7c488f3f0d1d4163b270afac1749eed954b}"
generator_repository="${QRL_GENESIS_GENERATOR_REPOSITORY:-https://github.com/theQRL/qrl-genesis-generator.git}"
generator_commit="${QRL_GENESIS_GENERATOR_COMMIT:-6a11fbcee762af14d188507f071d08ac5782fa69}"
generator_patch="${repo_root}/docker/qrysm/qrl-genesis-generator-qrl2-pq.patch"

beacon_image="qrl2-qns/qrysm:beacon-chain-64"
validator_image="qrl2-qns/qrysm:validator-64"
generator_image="qrl2-qns/qrysm:qrl-genesis-generator-64"

command -v docker >/dev/null
command -v git >/dev/null
command -v sha256sum >/dev/null

if [[ ! -f "${generator_patch}" ]]; then
    echo "QRL2 genesis-generator patch not found at ${generator_patch}" >&2
    exit 1
fi

generator_patch_sha="$(sha256sum "${generator_patch}" | awk '{print $1}')"
generator_source_dir="$(mktemp -d)"
cleanup() {
    rm -rf -- "${generator_source_dir}"
}
trap cleanup EXIT

common_args=(
    --file "${dockerfile}"
    --build-arg "QRYSM_REPOSITORY=${qrysm_repository}"
    --build-arg "QRYSM_COMMIT=${qrysm_commit}"
    --label "org.opencontainers.image.source=${qrysm_repository}"
    --label "org.opencontainers.image.revision=${qrysm_commit}"
)

if [[ -n "${QNS_DOCKER_CGROUP_PARENT:-}" ]]; then
    common_args+=(--cgroup-parent "${QNS_DOCKER_CGROUP_PARENT}")
fi

docker build \
    "${common_args[@]}" \
    --target beacon-chain \
    --tag "${beacon_image}" \
    "${repo_root}"

docker build \
    "${common_args[@]}" \
    --target validator \
    --tag "${validator_image}" \
    "${repo_root}"

generator_args=(
    --build-arg "QRYSM_GIT_REPO=${qrysm_repository}"
    --build-arg "QRYSM_GIT_REF=${qrysm_commit}"
    --label "org.opencontainers.image.source=${generator_repository}"
    --label "org.opencontainers.image.revision=${generator_commit}"
    --label "org.qrl.qns.source-patch-sha256=${generator_patch_sha}"
    --label "org.qrl.qns.qrl2-pq-precompiles-time=0"
    --tag "${generator_image}"
)

if [[ -n "${QNS_DOCKER_CGROUP_PARENT:-}" ]]; then
    generator_args+=(--cgroup-parent "${QNS_DOCKER_CGROUP_PARENT}")
fi

git -C "${generator_source_dir}" init --quiet
git -C "${generator_source_dir}" remote add origin "${generator_repository}"
git -C "${generator_source_dir}" fetch --quiet --depth 1 origin "${generator_commit}"
git -C "${generator_source_dir}" checkout --quiet --detach FETCH_HEAD
if [[ "$(git -C "${generator_source_dir}" rev-parse HEAD)" != "${generator_commit}" ]]; then
    echo "Fetched genesis-generator revision does not match ${generator_commit}" >&2
    exit 1
fi
git -C "${generator_source_dir}" apply --check "${generator_patch}"
git -C "${generator_source_dir}" apply "${generator_patch}"

docker build \
    "${generator_args[@]}" \
    "${generator_source_dir}"

docker run --rm "${beacon_image}" --version
docker run --rm "${validator_image}" --version
docker run --rm --entrypoint /usr/local/bin/qrysmctl "${generator_image}" --help >/dev/null
docker run --rm --entrypoint /usr/local/bin/deposit "${generator_image}" --help >/dev/null

echo "Built ${beacon_image}"
echo "Built ${validator_image}"
echo "Built ${generator_image}"
