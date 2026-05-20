#!/usr/bin/env bash
# One-click updater for Docker Compose deployments.
#
# This updates the app container image and recreates only the app service. It is
# intentionally not a hot patch of the running Rust process.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

MODE="auto"
COMPOSE_DIR=""
APP_SERVICE="app"
NO_PULL=false
FORCE_RECREATE=false
SHOW_LOGS=false
LOCAL_BUILD=false
PREPARE_ONLY=false
COMPOSE_FILES=()

usage() {
    cat <<'EOF'
Usage: ./update.sh [options]

Update Aether Docker Compose deployment in one command.

Options:
  --mode MODE             auto, compose, single-node, or local-build
                          auto uses docker-compose.yml in the current directory
  --compose-dir DIR       deployment directory, default: current directory
  -f, --compose-file FILE compose file path; can be provided multiple times
  --service NAME          app service name, default: app
  --no-pull               skip docker compose pull
  --prepare               pull the latest app image only, do not recreate app
  --force-recreate        force recreate the app container
  --logs                  follow app logs after update
  -h, --help              show help

Examples:
  ./update.sh
  ./update.sh --mode single-node
  ./update.sh --compose-dir /opt/aether/compose
  ./update.sh --mode local-build
EOF
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)
            [[ $# -ge 2 ]] || die "--mode requires a value"
            MODE="$2"
            shift 2
            ;;
        --compose-dir)
            [[ $# -ge 2 ]] || die "--compose-dir requires a value"
            COMPOSE_DIR="$2"
            shift 2
            ;;
        -f|--compose-file)
            [[ $# -ge 2 ]] || die "--compose-file requires a value"
            COMPOSE_FILES+=("$2")
            shift 2
            ;;
        --service)
            [[ $# -ge 2 ]] || die "--service requires a value"
            APP_SERVICE="$2"
            shift 2
            ;;
        --no-pull)
            NO_PULL=true
            shift
            ;;
        --prepare)
            PREPARE_ONLY=true
            shift
            ;;
        --force-recreate)
            FORCE_RECREATE=true
            shift
            ;;
        --logs)
            SHOW_LOGS=true
            shift
            ;;
        --local-build)
            MODE="local-build"
            LOCAL_BUILD=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "unknown argument: $1"
            ;;
    esac
done

case "$MODE" in
    auto|compose|single-node|local-build)
        ;;
    *)
        die "unsupported mode: ${MODE}; expected auto, compose, single-node, or local-build"
        ;;
esac

if [[ "${MODE}" == "local-build" || "${LOCAL_BUILD}" == "true" ]]; then
    [[ "${PREPARE_ONLY}" != "true" ]] || die "--prepare is only supported for Docker Compose deployments"
    deploy_script="${SCRIPT_DIR}/deploy.sh"
    [[ -f "${deploy_script}" ]] || die "local-build mode requires deploy.sh next to update.sh"
    args=()
    if [[ "${FORCE_RECREATE}" == "true" ]]; then
        args+=(--force)
    fi
    exec bash "${deploy_script}" "${args[@]}"
fi

if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
else
    die "docker compose or docker-compose is required"
fi

docker info >/dev/null 2>&1 || die "Docker is not running"

if [[ -z "${COMPOSE_DIR}" ]]; then
    COMPOSE_DIR="$(pwd -P)"
fi
COMPOSE_DIR="$(cd -- "${COMPOSE_DIR}" && pwd -P)"

resolve_compose_file() {
    local filename="$1"
    if [[ "${filename}" = /* ]]; then
        printf '%s\n' "${filename}"
    else
        printf '%s\n' "${COMPOSE_DIR}/${filename}"
    fi
}

if [[ "${#COMPOSE_FILES[@]}" -eq 0 ]]; then
    case "${MODE}" in
        compose)
            COMPOSE_FILES=("docker-compose.yml")
            ;;
        single-node)
            if [[ -f "${COMPOSE_DIR}/docker-compose.single-node.yml" ]]; then
                COMPOSE_FILES=("docker-compose.single-node.yml")
            else
                COMPOSE_FILES=("docker-compose.yml")
            fi
            ;;
        auto)
            if [[ -f "${COMPOSE_DIR}/docker-compose.yml" ]]; then
                COMPOSE_FILES=("docker-compose.yml")
            elif [[ -f "${COMPOSE_DIR}/docker-compose.single-node.yml" ]]; then
                COMPOSE_FILES=("docker-compose.single-node.yml")
            else
                die "no docker-compose.yml or docker-compose.single-node.yml found in ${COMPOSE_DIR}"
            fi
            ;;
    esac

    if [[ -f "${COMPOSE_DIR}/docker-compose.update.yml" ]]; then
        COMPOSE_FILES+=("docker-compose.update.yml")
    fi
fi

COMPOSE_ARGS=()
COMPOSE_ARGS+=(--project-directory "${COMPOSE_DIR}")
for file in "${COMPOSE_FILES[@]}"; do
    resolved_file="$(resolve_compose_file "${file}")"
    [[ -f "${resolved_file}" ]] || die "compose file not found: ${resolved_file}"
    COMPOSE_ARGS+=(-f "${resolved_file}")
done

services="$("${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" config --services)"
if ! grep -qx "${APP_SERVICE}" <<< "${services}"; then
    die "service '${APP_SERVICE}' not found in compose config"
fi

echo ">>> Compose directory: ${COMPOSE_DIR}"
echo ">>> App service: ${APP_SERVICE}"

if [[ "${PREPARE_ONLY}" == "true" ]]; then
    echo ">>> Preparing update by pulling latest image for ${APP_SERVICE}..."
    "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" pull "${APP_SERVICE}"
    echo ">>> Done."
    echo ">>> Note: image is downloaded. Recreate ${APP_SERVICE} to apply the update."
    exit 0
fi

if [[ "${NO_PULL}" != "true" ]]; then
    echo ">>> Pulling latest image for ${APP_SERVICE}..."
    "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" pull "${APP_SERVICE}"
fi

has_healthcheck() {
    "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" config 2>/dev/null \
        | grep -q "healthcheck:" 2>/dev/null
}

wait_healthy() {
    local timeout="${1:-120}"
    local elapsed=0
    echo ">>> Waiting for ${APP_SERVICE} to become healthy (timeout ${timeout}s)..."
    while (( elapsed < timeout )); do
        local container_id
        local state
        container_id="$("${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" ps -q "${APP_SERVICE}" 2>/dev/null | head -n 1)"
        if [[ -z "${container_id}" ]]; then
            sleep 2
            elapsed=$(( elapsed + 2 ))
            continue
        fi
        state="$(docker inspect --format='{{.State.Health.Status}}' \
            "${container_id}" 2>/dev/null || true)"
        if [[ "${state}" == "healthy" ]]; then
            echo ">>> Container is healthy."
            return 0
        fi
        sleep 2
        elapsed=$(( elapsed + 2 ))
    done
    echo ">>> WARNING: health check timed out after ${timeout}s."
    return 1
}

# Update execution.
# When a healthcheck is defined we use --wait so compose blocks until
# the new container passes health, reducing observable downtime.

up_args=(up -d)
if [[ "${FORCE_RECREATE}" == "true" ]]; then
    up_args+=(--force-recreate)
fi

# Compose v2.20+ supports --wait; older versions may reject it.
if has_healthcheck; then
    up_args+=(--wait --wait-timeout 120)
fi
up_args+=("${APP_SERVICE}")

echo ">>> Recreating ${APP_SERVICE}..."
"${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" "${up_args[@]}" || {
    echo ">>> Compose up with --wait failed; falling back to simple recreate..."
    fallback_up_args=(up -d)
    if [[ "${FORCE_RECREATE}" == "true" ]]; then
        fallback_up_args+=(--force-recreate)
    fi
    fallback_up_args+=("${APP_SERVICE}")
    "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" "${fallback_up_args[@]}"
    if has_healthcheck; then
        wait_healthy 120 || true
    fi
}

echo ">>> Current services:"
"${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" ps

echo ">>> Done."
echo ">>> Note: this is a one-click app container update, not a no-restart hot patch."

if [[ "${SHOW_LOGS}" == "true" ]]; then
    "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" logs -f "${APP_SERVICE}"
fi
