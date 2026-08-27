#!/usr/bin/env bash
set -euo pipefail

enclave="${KURTOSIS_ENCLAVE:-qrl2-qns-pq}"
runtime_dir="${TMPDIR:-/tmp}/myqrlwallet-qns-${UID}/${enclave}"
proxy_pid_file="${runtime_dir}/rpc-proxy.pid"
proxy_unit="myqrlwallet-qns-rpc-${enclave}.service"
proxy_description="MyQRLWallet QNS RPC proxy for ${enclave}"

if [[ ! "${enclave}" =~ ^[[:alnum:]][[:alnum:]_-]*$ ]]; then
    echo "KURTOSIS_ENCLAVE must start with an alphanumeric character and contain only alphanumerics, underscores, or hyphens." >&2
    exit 1
fi

if command -v systemctl >/dev/null && systemctl --user cat "${proxy_unit}" >/dev/null 2>&1; then
    description="$(systemctl --user show "${proxy_unit}" --property=Description --value 2>/dev/null || true)"
    if [[ "${description}" != "${proxy_description}" ]]; then
        echo "Refusing to stop ${proxy_unit}: its description does not identify the QNS RPC proxy." >&2
        exit 1
    fi
    systemctl --user stop "${proxy_unit}"
    systemctl --user reset-failed "${proxy_unit}" >/dev/null 2>&1 || true
fi

if [[ -f "${proxy_pid_file}" ]]; then
    proxy_pid="$(<"${proxy_pid_file}")"
    if [[ "${proxy_pid}" =~ ^[0-9]+$ ]] && kill -0 "${proxy_pid}" 2>/dev/null; then
        command_line="$(tr '\0' ' ' < "/proc/${proxy_pid}/cmdline" 2>/dev/null || true)"
        if [[ "${command_line}" == *"TCP-LISTEN:32002,bind=127.0.0.1"* ]]; then
            kill "${proxy_pid}"
            for _ in {1..50}; do
                if ! kill -0 "${proxy_pid}" 2>/dev/null; then
                    break
                fi
                sleep 0.1
            done
            if kill -0 "${proxy_pid}" 2>/dev/null; then
                echo "The QNS RPC proxy PID ${proxy_pid} did not stop." >&2
                exit 1
            fi
        else
            echo "Refusing to stop PID ${proxy_pid}: it is not the QNS RPC proxy." >&2
            exit 1
        fi
    fi
    rm -f -- "${proxy_pid_file}"
fi

if enclave_inspect="$(kurtosis enclave inspect "${enclave}" 2>/dev/null)"; then
    enclave_status="$(sed -n 's/^Status:[[:space:]]*//p' <<< "${enclave_inspect}")"
    if [[ "${enclave_status}" == "RUNNING" ]]; then
        kurtosis enclave stop "${enclave}"
    fi
fi

echo "Stopped QNS RPC proxy and enclave ${enclave}."
