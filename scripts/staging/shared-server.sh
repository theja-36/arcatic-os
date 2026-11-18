#!/usr/bin/env bash
# Staging on a SHARED VPS (a Coolify/Traefik host that already runs other containers).
#
#   scripts/staging/shared-server.sh precheck     read-only: memory, swap, disk, Traefik network, name clashes, DNS
#   scripts/staging/shared-server.sh deploy       NEEDS owner approval: APPROVED_DEPLOY=yes ... deploy
#   scripts/staging/shared-server.sh status       read-only: our containers, memory, health
#   scripts/staging/shared-server.sh stop         stops ONLY the arcatic-os-staging project
#
# Uses the SSH host alias given in SSH_HOST (required). Never touches other containers,
# the firewall, DNS or Traefik's configuration. Secrets travel over SSH to a mode-600 file and are never printed.
set -euo pipefail
SSH_HOST="${SSH_HOST:?set SSH_HOST to the SSH config alias of the staging server}"
DIR=/srv/arcatic-os-staging
PROJECT=arcatic-os-staging
ENV_FILE="${ENV_FILE:-.env.staging}"
MIN_AVAIL_MB="${MIN_AVAIL_MB:-3000}"      # refuse to build/start if the server has less memory available than this
MIN_DISK_GB="${MIN_DISK_GB:-20}"
cmd="${1:-}"
remote() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$SSH_HOST" "$@"; }
val() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -E "s/[[:space:]]+#.*$//" | tr -d "\""; }

precheck() {
  local fail=0 web api ip
  web="$(val APP_URL | sed -E 's#^https?://##; s#/.*##')"; api="$(val API_PUBLIC_URL | sed -E 's#^https?://##; s#/.*##')"
  echo "== server (read-only)"
  remote 'bash -s' <<'REMOTE' || fail=1
set -e
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
swapused=$(awk '/SwapTotal/ {t=$2} /SwapFree/ {f=$2} END {print int((t-f)/1024)}' /proc/meminfo)
disk=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
echo "MemAvailable_MB=$avail SwapUsed_MB=$swapused DiskFree_GB=$disk Load=$(cut -d' ' -f1-3 /proc/loadavg)"
docker network inspect coolify >/dev/null 2>&1 && echo "network coolify: present" || echo "network coolify: MISSING"
docker ps --format '{{.Names}}' | grep -q '^coolify-proxy$' && echo "traefik (coolify-proxy): running" || echo "traefik: NOT running"
n=$(docker ps -a --format '{{.Names}}' | grep -c '^arcatic-os-staging-' || true); echo "existing arcatic-os-staging containers: $n"
[ -d /srv/arcatic-os-staging ] && echo "/srv/arcatic-os-staging: exists" || echo "/srv/arcatic-os-staging: absent"
REMOTE
  read -r avail disk < <(remote "awk '/MemAvailable/ {printf \"%d \", \$2/1024}' /proc/meminfo; df -BG --output=avail / | tail -1 | tr -dc 0-9") || true
  [ "${avail:-0}" -ge "$MIN_AVAIL_MB" ] && echo "PASS memory available ${avail} MB ≥ ${MIN_AVAIL_MB}" || { echo "FAIL memory available ${avail:-?} MB < ${MIN_AVAIL_MB}"; fail=1; }
  [ "${disk:-0}" -ge "$MIN_DISK_GB" ] && echo "PASS disk free ${disk} GB ≥ ${MIN_DISK_GB}" || { echo "FAIL disk free ${disk:-?} GB < ${MIN_DISK_GB}"; fail=1; }
  echo "== DNS (from here)"
  ip="$(remote "curl -fsS -m 5 https://api.ipify.org" 2>/dev/null || true)"
  for h in "$web" "$api"; do
    [ -z "$h" ] && { echo "FAIL hostname not set in $ENV_FILE (APP_URL / API_PUBLIC_URL)"; fail=1; continue; }
    got="$(dig +short "$h" A | head -1)"
    [ -n "$got" ] && [ "$got" = "$ip" ] && echo "PASS $h → $got" || { echo "FAIL $h resolves to '${got:-nothing}', server is '${ip:-?}'"; fail=1; }
  done
  return $fail
}

case "$cmd" in
  precheck) precheck && echo "precheck OK" || { echo "precheck found problems"; exit 1; } ;;
  status)
    remote "docker ps -a --filter name=${PROJECT}- --format '{{.Names}}\t{{.Status}}'; docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' \$(docker ps -q --filter name=${PROJECT}-) 2>/dev/null; free -m | sed -n 1,3p" ;;
  stop) remote "cd $DIR && docker compose -p $PROJECT -f infrastructure/docker-compose.staging-shared.yml stop" ;;
  deploy)
    [ "${APPROVED_DEPLOY:-}" = "yes" ] || { echo "Refusing: the owner has not approved a deploy (set APPROVED_DEPLOY=yes)."; exit 2; }
    [ "$(val STAGING_TARGET)" = "staging" ] || { echo "Refusing: STAGING_TARGET must be staging in $ENV_FILE"; exit 2; }
    precheck || { echo "Refusing to deploy: precheck failed."; exit 1; }
    commit="$(git rev-parse --short HEAD)"; git diff --quiet && git diff --cached --quiet || { echo "Refusing: uncommitted changes (deploy a commit)."; exit 2; }
    echo "== ship commit $commit (git archive; no secrets in it)"
    remote "mkdir -p $DIR && chmod 700 $DIR && find $DIR -mindepth 1 -maxdepth 1 ! -name .env.staging -exec rm -rf {} +"
    git archive --format=tar HEAD | remote "tar -x -C $DIR"
    echo "== ship $ENV_FILE (mode 600, not printed)"
    ssh -o BatchMode=yes "$SSH_HOST" "umask 177 && cat > $DIR/.env.staging" < "$ENV_FILE"
    WEB_HOST="$(val APP_URL | sed -E 's#^https?://##; s#/.*##')"; API_HOST="$(val API_PUBLIC_URL | sed -E 's#^https?://##; s#/.*##')"
    echo "== build one image at a time, lowest priority, memory-checked"
    for svc in api web worker; do
      avail="$(remote "awk '/MemAvailable/ {printf \"%d\", \$2/1024}' /proc/meminfo")"
      [ "$avail" -ge "$MIN_AVAIL_MB" ] || { echo "Stopping: only ${avail} MB available before building $svc."; exit 1; }
      remote "cd $DIR && WEB_HOST=$WEB_HOST API_HOST=$API_HOST nice -n 19 ionice -c3 docker compose -p $PROJECT -f infrastructure/docker-compose.staging-shared.yml --env-file .env.staging build $svc"
    done
    echo "== start"
    remote "cd $DIR && WEB_HOST=$WEB_HOST API_HOST=$API_HOST docker compose -p $PROJECT -f infrastructure/docker-compose.staging-shared.yml --env-file .env.staging up -d"
    echo "deployed commit $commit"; "$0" status ;;
  *) sed -n 2,12p "$0"; exit 1 ;;
esac
