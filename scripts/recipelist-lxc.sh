#!/bin/bash
# Install/update RecipeList on a dedicated Debian LXC. Run as root.
set -Eeuo pipefail
umask 077
# Keep privileged command lookup away from the optional /usr/local tree until
# its ownership and permissions have been checked below.
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
APP=/opt/recipelist
ENV_FILE=/etc/recipelist/recipelist.env
UNIT=/etc/systemd/system/recipelist.service
REPO=https://github.com/16Boyd/recipelist.git
BACKUP=
TMP=
CONFIG_TMP=
UNIT_TMP=
BUILD_HOME=
NODE_STAGE=
NODE_LINK_STAGE=
NODE_PUBLISHED=false
PG_DUMP=
PG_RESTORE=
BUILD_ACTIVE=false
LOCK_DIR=/run/recipelist-lxc
STOPPED=false
SERVICE_WAS_ACTIVE=false
OPERATION_STARTED=false
# Print supported installer and updater options.
usage() {
  cat <<'HELP'
Usage: recipelist-lxc.sh install [--url ORIGIN] [--bind-address ADDRESS] [--trust-proxy true|false]
       recipelist-lxc.sh update [--ref BRANCH|TAG|COMMIT]
       recipelist-lxc.sh --help

Install requires a fresh Debian 12/13 systemd guest. Defaults: URL
http://localhost:3000, bind 127.0.0.1, trust-proxy false. Non-loopback origins
require HTTPS. Bind may be 127.0.0.1 or explicitly 0.0.0.0 for an external
proxy. Firewall port 3000 to that proxy only; trusted proxies must overwrite
Host, X-Forwarded-Host and X-Forwarded-Proto with the original host/protocol.

Update preserves configuration/data and requires a clean checkout. Run as root:
it installs missing Debian prerequisites and PostgreSQL client tools, and installs
the latest supported Node LTS if Node/npm are missing, unusable or Node is below 22.
An existing Node >=22 with working npm is kept. PostgreSQL must already be installed and
running; update does not install its server. Provisioning and ref resolution finish
before the app is stopped, though apt hooks may restart system services. npm ci can
still download dependencies while RecipeList is stopped. The app stops briefly
while a private PostgreSQL custom dump is created and verified; a dump/list failure
restarts the unchanged app only if
it was active beforehand, and leaves an inactive app inactive. Archive
verification is NOT a restore test. The app stays down during checkout/build/
migrations until health succeeds. Failures after checkout starts may leave it
down. Migrations may be irreversible: recovery can require manual database
restore plus compatible code. Back up configuration separately.
HELP
}
# Report a fatal setup error and terminate the installer.
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
# Reject a path whose existing components are symlinks or not root-owned and protected.
assert_root_path() {
  local path=$1 kind=$2 part current=/ owner_mode
  local -a parts=()
  IFS=/ read -r -a parts <<< "$path"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    current=${current%/}/$part
    [[ ! -L "$current" ]] || die "Symlink in protected path: $current"
    owner_mode=$(stat -c '%u:%a' "$current" 2>/dev/null) || die "Missing protected path: $current"
    [[ ${owner_mode%%:*} == 0 ]] || die "Protected path must be root-owned: $current"
    if (( (8#${owner_mode#*:} & 8#022) != 0 )); then
      if [[ "$current" == /usr/local || "$current" == /usr/local/lib || "$current" == /usr/local/bin ]]; then
        die "Protected path is group/world writable: $current. Debian's optional staff-group-for-usr-local configuration is unsupported; restore root-owned, non-writable permissions before running this installer."
      fi
      die "Protected path is group/world writable: $current"
    fi
    if [[ "$current" != "$path" ]]; then
      [[ -d "$current" ]] || die "Protected path ancestor is not a directory: $current"
    elif [[ "$kind" == dir ]]; then
      [[ -d "$current" ]] || die "Protected path is not a directory: $current"
    else
      [[ -f "$current" ]] || die "Protected path is not a regular file: $current"
    fi
  done
}
# Verify /usr/local/bin is a safe root-controlled location before trusting its commands.
assert_safe_local_bin() {
  local entry target
  while IFS= read -r -d '' entry; do
    [[ -d "$entry" ]] && continue
    target=$(readlink -f -- "$entry") || die "Cannot resolve executable in protected path: $entry"
    [[ -f "$target" ]] || die "Non-regular executable in protected path: $entry"
    assert_root_path "$target" file
  done < <(find /usr/local/bin -mindepth 1 -maxdepth 1 \( -type f -o -type l \) -print0)
}
# Check that a candidate unit exactly matches the supported service security configuration.
validate_service_unit() {
  /usr/bin/python3 - "$1" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    lines = path.read_text(encoding="utf-8").splitlines()
except (OSError, UnicodeError) as exc:
    sys.exit(f"Cannot read service unit as UTF-8: {exc}")

# This is deliberately a small allowlist for the managed unit, not a general
# systemd parser. Reject syntax we do not inspect rather than risk systemd
# interpreting an override or privilege-affecting directive differently.
allowed = {
    "Unit": {"Description", "After", "Wants"},
    "Service": {
        "Type", "User", "Group", "WorkingDirectory", "EnvironmentFile",
        "ExecStartPre", "ExecStart", "Restart", "RestartSec", "TimeoutStopSec",
        "NoNewPrivileges", "PrivateTmp", "PrivateDevices", "ProtectSystem",
        "ProtectHome", "ProtectKernelTunables", "ProtectKernelModules",
        "ProtectControlGroups", "RestrictSUIDSGID", "LockPersonality",
    },
    "Install": {"WantedBy"},
}
expected = {
    ("Unit", "Description"): "RecipeList web application",
    ("Unit", "After"): "network.target postgresql.service",
    ("Unit", "Wants"): "postgresql.service",
    ("Service", "Type"): "simple",
    ("Service", "User"): "recipelist",
    ("Service", "Group"): "recipelist",
    ("Service", "WorkingDirectory"): "/opt/recipelist",
    ("Service", "EnvironmentFile"): "/etc/recipelist/recipelist.env",
    ("Service", "ExecStartPre"): "/usr/bin/env node dist-server/server/migrate.js",
    ("Service", "ExecStart"): "/usr/bin/env node dist-server/server/index.js",
    ("Service", "Restart"): "on-failure",
    ("Service", "RestartSec"): "5s",
    ("Service", "TimeoutStopSec"): "30s",
    ("Service", "NoNewPrivileges"): "true",
    ("Service", "PrivateTmp"): "true",
    ("Service", "PrivateDevices"): "true",
    ("Service", "ProtectSystem"): "strict",
    ("Service", "ProtectHome"): "true",
    ("Service", "ProtectKernelTunables"): "true",
    ("Service", "ProtectKernelModules"): "true",
    ("Service", "ProtectControlGroups"): "true",
    ("Service", "RestrictSUIDSGID"): "true",
    ("Service", "LockPersonality"): "true",
    ("Install", "WantedBy"): "multi-user.target",
}
sections = set()
values = {}
section = None
for number, line in enumerate(lines, 1):
    stripped = line.strip()
    if not stripped or stripped.startswith(("#", ";")):
        continue
    if line.endswith("\\"):
        sys.exit(f"Unsupported line continuation in service unit at line {number}.")
    if line != line.lstrip():
        sys.exit(f"Unsupported leading whitespace in service unit at line {number}.")
    match = re.fullmatch(r"\[([A-Za-z][A-Za-z0-9]*)\]", line)
    if match:
        section = match.group(1)
        if section not in allowed:
            sys.exit(f"Unsupported service unit section [{section}].")
        if section in sections:
            sys.exit(f"Duplicate service unit section [{section}].")
        sections.add(section)
        continue
    match = re.fullmatch(r"([A-Za-z][A-Za-z0-9]*)=(.*)", line)
    if not match or section is None:
        sys.exit(f"Unsupported service unit syntax at line {number}.")
    key, value = match.groups()
    if key not in allowed[section]:
        sys.exit(f"Unsupported directive {key} in [{section}].")
    identity = (section, key)
    if identity in values:
        sys.exit(f"Duplicate directive {key} in [{section}].")
    if not value or value != value.strip():
        sys.exit(f"Empty or whitespace-padded directive {key} in [{section}].")
    if key.startswith("Exec"):
        # Require a plain absolute executable path as the first token. This
        # excludes systemd's + and ! privilege-bypass prefixes (and all other
        # command prefixes) without trying to emulate its command lexer.
        if not re.match(r"^/[^\s;#'\"\\]+(?:[ \t]+.*)?$", value):
            sys.exit(f"Unsupported or privileged command syntax in {key}.")
    values[identity] = value

if sections != set(allowed):
    sys.exit("Service unit must contain exactly [Unit], [Service] and [Install] sections.")
if values != expected:
    sys.exit("Service unit directives must match the managed RecipeList systemd unit exactly.")
PY
}
# Reject systemd drop-ins that could override the managed RecipeList service.
assert_no_unit_dropin_files() {
  local unit_paths base dropin_dir dropin
  local -a search_paths=()
  unit_paths=$(systemctl show --property=UnitPath --value) || die 'Could not inspect systemd unit search paths.'
  [[ -n "$unit_paths" ]] || die 'Systemd reported no unit search paths.'
  read -r -a search_paths <<< "$unit_paths"
  for base in "${search_paths[@]}"; do
    for dropin_dir in "$base/recipelist.service.d" "$base/service.d"; do
      [[ -d "$dropin_dir" ]] || continue
      assert_root_path "$dropin_dir" dir
      dropin=$(find "$dropin_dir" -mindepth 1 -maxdepth 1 -name '*.conf' -print -quit)
      if [[ -n "$dropin" ]]; then
        die "RecipeList systemd drop-in exists: $dropin. Review the effective unit configuration manually before proceeding."
      fi
    done
  done
}
# Check both system and transient systemd configuration for service overrides.
assert_no_unit_dropins() {
  local dropins
  assert_no_unit_dropin_files
  dropins=$(systemctl show --property=DropInPaths --value recipelist.service) || die 'Could not inspect merged RecipeList systemd unit drop-ins.'
  [[ -z "$dropins" ]] || die 'RecipeList systemd drop-ins are unsupported; review the effective unit configuration manually before proceeding.'
}
# Remove staged temporary files and restore service state after interruption or failure.
cleanup() {
  local code=$?
  trap - EXIT
  trap - ERR
  set +e
  [[ -z "$TMP" ]] || rm -rf -- "$TMP"
  [[ -z "$CONFIG_TMP" ]] || rm -f -- "$CONFIG_TMP"
  [[ -z "$UNIT_TMP" ]] || rm -f -- "$UNIT_TMP"
  [[ -z "$BUILD_HOME" ]] || rm -rf -- "$BUILD_HOME"
  [[ -z "$NODE_LINK_STAGE" ]] || rm -rf -- "$NODE_LINK_STAGE"
  [[ -z "$NODE_STAGE" || "$NODE_PUBLISHED" == true ]] || rm -rf -- "$NODE_STAGE"
  if [[ "$BUILD_ACTIVE" == true ]]; then
    secure_app || printf 'Could not fully restore protected checkout ownership and modes; inspect %s manually.\n' "$APP" >&2
  fi
  if (( code != 0 )) && [[ "$OPERATION_STARTED" == true ]]; then
    if [[ "$MODE" == install && ! -e "$UNIT" ]]; then
      printf 'Install did not complete and may have made partial system changes: the recipelist user/group, PostgreSQL role/database, %s, and %s may already exist. Review the errors above before retrying; partial artifacts and PostgreSQL data are not removed automatically.\n' "$ENV_FILE" "$APP" >&2
    else
      printf 'RecipeList operation failed. Inspect: journalctl -u recipelist -b\n' >&2
    fi
    [[ -z "$BACKUP" ]] || printf 'Database archive: %s\nVerify recovery in a separate database; stop recipelist before any manual restore. Migrations do not roll back automatically. Preserve /etc/recipelist/recipelist.env.\n' "$BACKUP" >&2
    [[ "$STOPPED" == false ]] || printf 'The service was stopped for this update; inspect its state before restarting.\n' >&2
  fi
  exit "$code"
}
[[ ${1:-} != --help && ${1:-} != -h ]] || { usage; exit 0; }
MODE=${1:-}
[[ "$MODE" == install || "$MODE" == update ]] || { usage >&2; exit 2; }
shift
URL=http://localhost:3000
BIND=127.0.0.1
PROXY=false
REF=main
declare -A SEEN=()
while (( $# )); do
  OPTION=$1
  [[ "$OPTION" != --help && "$OPTION" != -h ]] || { usage; exit 0; }
  [[ $# -ge 2 && -n $2 && $2 != --* ]] || die "Missing value for $OPTION"
  [[ ! ${SEEN[$OPTION]+present} ]] || die "Duplicate option: $OPTION"
  SEEN[$OPTION]=1
  case "$MODE:$OPTION" in
    install:--url) URL=$2 ;;
    install:--bind-address) BIND=$2 ;;
    install:--trust-proxy) PROXY=$2 ;;
    update:--ref) REF=$2 ;;
    *) die "Unsupported option: $OPTION" ;;
  esac
  shift 2
done
trap cleanup EXIT
trap 'printf "Command failed at line %s (exit %s).\n" "$LINENO" "$?" >&2' ERR
[[ $EUID == 0 ]] || die 'Run as root.'
# shellcheck source=/dev/null
. /etc/os-release
[[ "$ID" == debian && ( "$VERSION_ID" == 12 || "$VERSION_ID" == 13 ) ]] || die 'Debian 12 or 13 is required.'
[[ -d /run/systemd/system ]] && command -v systemctl >/dev/null || die 'A running systemd guest is required.'
# Reject unsupported inputs before apt can make system changes.
case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) die 'Unsupported Debian architecture; latest-LTS installs support amd64 and arm64 only.' ;; esac
if [[ "$MODE" == update ]]; then
  [[ "$REF" != -* && "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$REF" != *..* && "$REF" != */ && "$REF" != *. ]] || die 'Unsafe ref; use a branch, tag or full commit ID.'
  IFS=/ read -r -a REF_PARTS <<< "$REF"
  for ref_part in "${REF_PARTS[@]}"; do
    [[ -n "$ref_part" && "$ref_part" != .* && "$ref_part" != *.lock ]] || die 'Unsafe ref; use a branch, tag or full commit ID.'
  done
else
  [[ "$BIND" == 127.0.0.1 || "$BIND" == 0.0.0.0 ]] || die 'Bind address must be 127.0.0.1 or 0.0.0.0.'
  [[ "$PROXY" == true || "$PROXY" == false ]] || die 'trust-proxy must be true or false.'
  [[ "$URL" =~ ^https?://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[::1\])(:([0-9]+))?/?$ ]] || die 'URL must be an HTTP(S) origin without credentials, path, query or fragment.'
  URL_PORT=${BASH_REMATCH[4]:-}
  if [[ -n "$URL_PORT" ]]; then
    [[ ${#URL_PORT} -le 5 ]] && (( 10#$URL_PORT >= 1 && 10#$URL_PORT <= 65535 )) || die 'URL port must be between 1 and 65535.'
  fi
  if [[ "$URL" == http://* ]]; then
    [[ "$URL" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?/?$ ]] || die 'Non-loopback URLs require HTTPS.'
  fi
fi
# Debian's default /usr/local permissions are root:root and not writable by
# group or others. A staff-writable /usr/local is intentionally unsupported:
# commands there must not be trusted during privileged package/setup work.
assert_root_path /usr/local/lib dir
assert_root_path /usr/local/bin dir
assert_safe_local_bin
PATH=/usr/local/bin:$PATH
export PATH
# Install required Debian packages when apt is available and package access is configured.
install_missing_packages() {
  local package
  local -a missing=()
  for package in "$@"; do
    if [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null) != 'install ok installed' ]]; then
      missing+=("$package")
    fi
  done
  if (( ${#missing[@]} )); then
    apt-get update
    apt-get install -y --no-install-recommends "${missing[@]}"
  fi
}
install_missing_packages util-linux
command -v flock >/dev/null || die 'flock (util-linux) is required.'
[[ ! -L /run && -d /run && $(stat -c '%u:%a' /run) == 0:755 ]] || die 'Unsafe /run directory.'
[[ ! -L "$LOCK_DIR" ]] || die 'Unsafe installer runtime directory.'
if [[ -e "$LOCK_DIR" ]]; then
  [[ -d "$LOCK_DIR" && $(stat -c '%u:%a' "$LOCK_DIR") == 0:700 ]] || die 'Unsafe installer runtime directory.'
else
  install -d -o root -g root -m 0700 "$LOCK_DIR"
fi
[[ -d "$LOCK_DIR" && ! -L "$LOCK_DIR" && $(stat -c '%u:%a' "$LOCK_DIR") == 0:700 ]] || die 'Unsafe installer runtime directory.'
[[ ! -L "$LOCK_DIR/lock" ]] || die 'Unsafe installer lock file.'
if [[ -e "$LOCK_DIR/lock" ]]; then
  [[ -f "$LOCK_DIR/lock" && $(stat -c '%u:%a' "$LOCK_DIR/lock") == 0:600 ]] || die 'Unsafe installer lock file.'
else
  install -o root -g root -m 0600 /dev/null "$LOCK_DIR/lock"
fi
exec 9>>"$LOCK_DIR/lock"
flock -n 9 || die 'Another RecipeList installer/updater is running.'
cd /
# Run a PostgreSQL client command as postgres with a controlled environment.
pg_run() { runuser -u postgres -- /usr/bin/env -i PATH="$PATH" LC_ALL=C "$@"; }
# Run a fail-fast psql query against the local PostgreSQL server as postgres.
pg() { pg_run psql -X -h /var/run/postgresql -p 5432 -U postgres -v ON_ERROR_STOP=1 -At "$@"; }
# Run Git with inherited repository and configuration overrides removed.
git_safe() {
  env -u GIT_CONFIG_PARAMETERS -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR \
    -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_EXEC_PATH \
    -u GIT_SSH -u GIT_SSH_COMMAND -u GIT_ASKPASS \
    GIT_CONFIG_COUNT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 \
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c credential.helper= "$@"
}
# Return success when the RecipeList database already exists.
db_exists() { [[ $(pg -d postgres -c "SELECT 1 FROM pg_database WHERE datname='recipelist'") == 1 ]]; }
# Return success when the RecipeList PostgreSQL role already exists.
role_exists() { [[ $(pg -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname='recipelist'") == 1 ]]; }
# Select and verify pg_dump and pg_restore clients compatible with the running server.
ensure_pg_dump_compatible() {
  local server_version server_major selected_major client_dump_version client_restore_version dump_major restore_major path candidate
  local exact_found=false
  local -a candidates=()
  server_version=$(pg -d postgres -c 'SHOW server_version_num')
  [[ "$server_version" =~ ^[0-9]+$ ]] || die 'Could not determine the PostgreSQL server version.'
  server_major=$((server_version / 10000))
  for path in /usr/lib/postgresql/[0-9]*; do
    [[ -d "$path" ]] || continue
    candidate=${path##*/}
    [[ "$candidate" =~ ^[0-9]+$ ]] || continue
    (( candidate >= server_major )) || continue
    [[ -x "$path/bin/pg_dump" && -x "$path/bin/pg_restore" ]] || continue
    if (( candidate == server_major )); then
      exact_found=true
    else
      candidates+=("$candidate")
    fi
  done
  if [[ "$exact_found" == true ]]; then
    selected_major=$server_major
  elif (( ${#candidates[@]} )); then
    selected_major=${candidates[0]}
    for candidate in "${candidates[@]}"; do
      (( candidate > selected_major )) && selected_major=$candidate
    done
  else
    install_missing_packages "postgresql-client-$server_major"
    path="/usr/lib/postgresql/$server_major"
    [[ -x "$path/bin/pg_dump" && -x "$path/bin/pg_restore" ]] || die "PostgreSQL client major $server_major is unavailable after package installation."
    selected_major=$server_major
  fi
  path="/usr/lib/postgresql/$selected_major/bin"
  PG_DUMP="$path/pg_dump"
  PG_RESTORE="$path/pg_restore"
  client_dump_version=$(pg_run "$PG_DUMP" --version) || die "Selected pg_dump client major $selected_major is unusable as postgres."
  client_restore_version=$(pg_run "$PG_RESTORE" --version) || die "Selected pg_restore client major $selected_major is unusable as postgres."
  [[ "$client_dump_version" =~ PostgreSQL\)\ ([0-9]+)\. ]] || die 'Could not determine selected pg_dump version.'
  dump_major=${BASH_REMATCH[1]}
  [[ "$client_restore_version" =~ PostgreSQL\)\ ([0-9]+)\. ]] || die 'Could not determine selected pg_restore version.'
  restore_major=${BASH_REMATCH[1]}
  (( dump_major >= server_major && restore_major == dump_major )) || die "Selected PostgreSQL client pair is incompatible with server major $server_major."
}
# Restore root ownership and remove group/other write access after a build.
secure_app() {
  chown -R -P --no-dereference root:root -- "$APP" || return $?
  chmod -R u+rwX -- "$APP" || return $?
  chmod -R a+rX,go-w -- "$APP" || return $?
  chmod 0755 "$APP" || return $?
  chown root:root "$ENV_FILE" || return $?
  chmod 0600 "$ENV_FILE" || return $?
}
# Build production assets as the restricted service user, then restore protected checkout permissions.
build() {
  local build_status=0 app_may_be_writable=false
  assert_root_path /var/cache dir
  BUILD_HOME=$(mktemp -d /var/cache/recipelist-build-home.XXXXXX) || return $?
  app_may_be_writable=true
  BUILD_ACTIVE=true
  if chown --no-dereference root:recipelist -- "$APP"; then :; else build_status=$?; fi
  if (( build_status == 0 )); then
    if chmod 1770 "$APP"; then :; else build_status=$?; fi
  fi
  # The sticky root-owned checkout directory prevents recipelist from replacing
  # its root-owned .git entry while allowing npm to write worktree files.
  if (( build_status == 0 )); then
    if find "$APP" -mindepth 1 -path "$APP/.git" -prune -o -exec chown --no-dereference recipelist:recipelist -- {} +; then :; else build_status=$?; fi
  fi
  if (( build_status == 0 )); then
    if chown -R -P --no-dereference root:root -- "$APP/.git" && chmod -R a-w -- "$APP/.git"; then :; else build_status=$?; fi
  fi
  if (( build_status == 0 )); then
    if chown --no-dereference recipelist:recipelist -- "$BUILD_HOME" && chmod 0700 -- "$BUILD_HOME"; then :; else build_status=$?; fi
  fi
  if (( build_status == 0 )); then
    if (cd "$APP" && \
        runuser -u recipelist -- env HOME="$BUILD_HOME" PATH="$PATH" npm ci --include=dev && \
        runuser -u recipelist -- env HOME="$BUILD_HOME" PATH="$PATH" npm run build && \
        runuser -u recipelist -- env HOME="$BUILD_HOME" PATH="$PATH" npm prune --omit=dev); then :; else
      build_status=$?
    fi
  fi
  if [[ -n "$BUILD_HOME" ]]; then
    if rm -rf -- "$BUILD_HOME"; then BUILD_HOME=; else build_status=$?; fi
  fi
  if [[ "$app_may_be_writable" == true ]]; then
    if secure_app; then BUILD_ACTIVE=false; else build_status=$?; fi
  fi
  return "$build_status"
}
# Wait for the service health endpoint and fail with a journal hint if it stays unavailable.
health() {
  wait_health && { printf 'RecipeList is healthy.\n'; return 0; }
  die 'Health check timed out; inspect journalctl -u recipelist -b.'
}
# Poll systemd and the local health endpoint for up to two minutes.
wait_health() {
  local attempt
  for attempt in {1..60}; do
    if systemctl is-active --quiet recipelist && curl --silent --fail --max-time 2 http://127.0.0.1:3000/api/healthz >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}
# Create or validate the private postgres-owned directory used for database dumps.
prepare_backup_directory() {
  local backup_dir=/var/backups/recipelist
  assert_root_path /var/backups dir
  [[ ! -L "$backup_dir" ]] || die 'Unsafe backup directory symlink.'
  if [[ -e "$backup_dir" ]]; then
    [[ -d "$backup_dir" && $(stat -c '%U:%G:%a' "$backup_dir") == postgres:postgres:700 ]] || die 'Existing backup directory must be postgres-owned with mode 0700.'
  else
    install -d -o postgres -g postgres -m 0700 "$backup_dir"
  fi
  [[ -d "$backup_dir" && ! -L "$backup_dir" && $(stat -c '%U:%G:%a' "$backup_dir") == postgres:postgres:700 ]] || die 'Could not create a private PostgreSQL backup directory.'
}
# Remove an incomplete dump, attempt to restore prior service availability, and abort the update.
backup_failure() {
  local reason=$1
  printf 'Backup failed: %s. No checkout or build has occurred.\n' "$reason" >&2
  if [[ -n "$BACKUP" ]]; then
    if runuser -u postgres -- rm -f -- "$BACKUP"; then
      BACKUP=
    else
      printf 'Could not remove the incomplete dump; inspect and remove it manually: %s\n' "$BACKUP" >&2
      BACKUP=
    fi
  fi
  if [[ "$SERVICE_WAS_ACTIVE" != true ]]; then
    STOPPED=false
    printf 'The service was inactive before the backup attempt; leaving it inactive.\n' >&2
  elif systemctl start recipelist; then
    STOPPED=false
    if wait_health; then
      printf 'The unchanged RecipeList service restarted and passed its health check.\n' >&2
    else
      printf 'ERROR: systemd started the unchanged RecipeList service, but its health check failed. Inspect journalctl -u recipelist -b.\n' >&2
    fi
  else
    printf 'ERROR: could not restart the unchanged RecipeList service; it may remain stopped. Inspect systemctl status recipelist and journalctl -u recipelist -b.\n' >&2
  fi
  die "$reason; update aborted before checkout."
}
# Return success only when Node 22 or newer and npm are usable.
node_supported() {
  command -v node >/dev/null && command -v npm >/dev/null &&
    node -e 'if(Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' &&
    npm --version >/dev/null
}
# Require the provisioned Node/npm runtime and print the selected Node version.
check_node() {
  node_supported || die 'A working Node >=22 and npm are required after runtime provisioning.'
  printf 'Using Node %s.\n' "$(node --version)"
}
# Download, verify, stage, and atomically publish the latest supported Node LTS runtime.
install_node() {
  local arch version archive link
  case "$(dpkg --print-architecture)" in
    amd64) arch=x64 ;; arm64) arch=arm64 ;;
    *) die 'Unsupported Debian architecture; latest-LTS installs support amd64 and arm64 only.' ;;
  esac
  TMP=$(mktemp -d)
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' https://nodejs.org/dist/index.json -o "$TMP/index.json"
  version=$(python3 - "$TMP/index.json" "$arch" <<'PY'
import json, sys
releases = [r for r in json.load(open(sys.argv[1])) if r.get('lts') and int(r['version'][1:].split('.')[0]) >= 22]
# Select latest LTS first; do not silently choose an older LTS for an unsupported architecture.
r = max(releases, key=lambda r: tuple(map(int, r['version'][1:].split('.'))))
if 'linux-' + sys.argv[2] not in r['files']:
    sys.exit('Latest LTS does not support this architecture')
print(r['version'])
PY
)
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Invalid Node metadata version.'
  archive=node-$version-linux-$arch.tar.xz
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "https://nodejs.org/dist/$version/$archive" -o "$TMP/$archive"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  (cd "$TMP"; awk -v file="$archive" '$2 == file { print; found=1 } END { if (!found) exit 1 }' SHASUMS256.txt > selected.sha256; sha256sum --check selected.sha256)
  assert_root_path /usr/local dir
  assert_root_path /usr/local/lib dir
  assert_root_path /usr/local/bin dir
  NODE_STAGE=$(mktemp -d /usr/local/lib/recipelist-node.XXXXXX)
  tar -xJf "$TMP/$archive" -C "$NODE_STAGE" --strip-components=1 --no-same-owner
  chmod -R a+rX,go-w "$NODE_STAGE"
  [[ -x "$NODE_STAGE/bin/node" && -x "$NODE_STAGE/bin/npm" && -x "$NODE_STAGE/bin/npx" && -f "$NODE_STAGE/lib/node_modules/npm/bin/npm-cli.js" ]] || die 'Downloaded Node archive is missing runtime commands.'
  "$NODE_STAGE/bin/node" -e 'if(Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
  "$NODE_STAGE/bin/node" "$NODE_STAGE/lib/node_modules/npm/bin/npm-cli.js" --version >/dev/null
  for link in node npm npx; do
    [[ ! -d "/usr/local/bin/$link" || -L "/usr/local/bin/$link" ]] || die "Cannot replace directory /usr/local/bin/$link with a Node command."
  done
  NODE_LINK_STAGE=$(mktemp -d /usr/local/bin/.recipelist-node-links.XXXXXX)
  for link in node npm npx; do ln -s "$NODE_STAGE/bin/$link" "$NODE_LINK_STAGE/$link"; done
  # Preserve the verified tree across a signal during any of these replacements.
  NODE_PUBLISHED=true
  for link in node npm npx; do
    mv -Tf "$NODE_LINK_STAGE/$link" "/usr/local/bin/$link"
  done
  rmdir "$NODE_LINK_STAGE"
  NODE_LINK_STAGE=
  NODE_STAGE=
  NODE_PUBLISHED=false
  hash -r
  check_node
}
if [[ "$MODE" == install ]]; then
  for path in "$APP" /etc/recipelist "$UNIT" /lib/systemd/system/recipelist.service /usr/lib/systemd/system/recipelist.service; do
    [[ ! -e "$path" && ! -L "$path" ]] || die "Existing installation artifact: $path"
  done
  assert_root_path /etc/systemd/system dir
  assert_no_unit_dropin_files
  ! getent passwd recipelist >/dev/null || die 'User recipelist already exists.'
  ! getent group recipelist >/dev/null || die 'Group recipelist already exists.'
  ! systemctl cat recipelist.service >/dev/null 2>&1 || die 'RecipeList unit already exists.'
  OPERATION_STARTED=true
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl git build-essential postgresql postgresql-client openssl python3 xz-utils util-linux
  command -v runuser >/dev/null || die 'runuser (util-linux) is required.'
  python3 - "$URL" <<'PY'
import sys, urllib.parse
u = urllib.parse.urlsplit(sys.argv[1])
try:
    valid = u.hostname and not u.username and not u.password and u.path in ('', '/') and not u.query and not u.fragment and (u.port is None or 1 <= u.port <= 65535)
except ValueError:
    valid = False
if not valid or (u.scheme != 'https' and u.hostname not in ('localhost', '127.0.0.1', '::1')):
    sys.exit('A valid origin is required; non-loopback URLs require HTTPS')
PY
  systemctl start postgresql
  ! db_exists || die 'Database recipelist already exists.'
  ! role_exists || die 'PostgreSQL role recipelist already exists.'
  install_node
  adduser --system --group --no-create-home recipelist
  PASSWORD=$(openssl rand -hex 32)
  SECRET=$(openssl rand -hex 32)
  # Generated hexadecimal is SQL-safe. Feed SQL on stdin, never in process arguments.
  pg -d postgres >/dev/null <<SQL
CREATE ROLE recipelist LOGIN PASSWORD '$PASSWORD';
CREATE DATABASE recipelist OWNER recipelist;
SQL
  install -d -o root -g root -m 0700 /etc/recipelist
  CONFIG_TMP=$(mktemp /etc/recipelist/.recipelist.env.XXXXXX)
  cat > "$CONFIG_TMP" <<CONFIG
NODE_ENV=production
DATABASE_URL=postgresql://recipelist:$PASSWORD@127.0.0.1:5432/recipelist
BETTER_AUTH_SECRET=$SECRET
BETTER_AUTH_URL=$URL
PORT=3000
HOST=$BIND
TRUST_PROXY=$PROXY
CONFIG
  chmod 0600 "$CONFIG_TMP"
  chown root:root "$CONFIG_TMP"
  mv -T "$CONFIG_TMP" "$ENV_FILE"
  CONFIG_TMP=
  unset PASSWORD SECRET
  git_safe clone --branch main --single-branch "$REPO" "$APP"
  UNIT_SOURCE=$APP/deploy/lxc/recipelist.service
  assert_root_path "$UNIT_SOURCE" file
  validate_service_unit "$UNIT_SOURCE"
  UNIT_TMP=$(mktemp /etc/systemd/system/.recipelist.service.XXXXXX)
  install -o root -g root -m 0644 "$UNIT_SOURCE" "$UNIT_TMP"
  build
  mv -fT -- "$UNIT_TMP" "$UNIT"
  UNIT_TMP=
  systemctl daemon-reload
  assert_no_unit_dropins
  systemctl enable --now recipelist
  health
else
  # Provision before preflight or downtime. Client tools do not install or
  # initialize a PostgreSQL server; the existing database remains required.
  install_missing_packages ca-certificates curl git build-essential postgresql-client openssl python3 xz-utils util-linux
  for command in git curl runuser psql; do command -v "$command" >/dev/null || die "Missing required command: $command"; done
  assert_root_path /opt/recipelist dir
  assert_root_path /etc/recipelist dir
  assert_root_path "$ENV_FILE" file
  assert_root_path /etc/systemd/system/recipelist.service file
  # Root ownership and no group/world write are checked on the full path above.
  # Older installs used 0750, so retain safe non-writable directory modes.
  [[ ! -L "$APP" && -d "$APP/.git" && ! -L "$APP/.git" && -f "$ENV_FILE" && ! -L "$ENV_FILE" && -f "$UNIT" && ! -L "$UNIT" ]] || die 'Existing repo, configuration and systemd unit are required.'
  [[ -z $(find "$APP" \( ! -user root -o \( ! -type l -a -perm /022 \) \) -print -quit) ]] || die 'Checkout must be root-owned and not group/world writable; review permissions manually.'
  [[ -z $(find "$APP/.git" \( -type l -o ! -user root -o -perm /022 \) -print -quit) ]] || die 'Git metadata must contain only root-owned, non-writable regular files and directories.'
  [[ $(git_safe -C "$APP" rev-parse --show-toplevel) == "$APP" ]] || die 'Invalid app repository.'
  [[ $(git_safe -C "$APP" remote get-url --all origin) == "$REPO" ]] || die 'Unexpected origin; expected public RecipeList HTTPS repository.'
  if git_safe -C "$APP" config --local --get-regexp '^filter\.' >/dev/null 2>&1; then
    die 'Custom Git filters are not supported in the protected checkout.'
  fi
  [[ -z $(git_safe -C "$APP" status --porcelain --untracked-files=all) ]] || die 'Checkout has tracked or untracked changes.'
  cmp -s "$UNIT" "$APP/deploy/lxc/recipelist.service" || die 'Installed service differs from the repository unit; review it manually before updating.'
  assert_no_unit_dropins
  systemctl is-active --quiet postgresql || die 'PostgreSQL must be running.'
  db_exists && role_exists || die 'Existing recipelist database and role are required.'
  ensure_pg_dump_compatible
  if ! node_supported; then
    install_node
  fi
  check_node
  # Do not source an environment file as shell code. Verify this managed local layout.
  [[ $(stat -c '%u:%a' "$ENV_FILE") == 0:600 ]] || die 'Configuration must be root-owned with mode 0600.'
  /usr/bin/env node --input-type=module - "$ENV_FILE" <<'JS'
import fs from 'node:fs';
const entries = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => { const i=l.indexOf('='); return [l.slice(0,i),l.slice(i+1)]; });
const e=Object.fromEntries(entries);
let u; try { u=new URL(e.DATABASE_URL); } catch { process.exit(1); }
if(u.protocol !== 'postgresql:' || u.hostname !== '127.0.0.1' || (u.port && u.port !== '5432') || u.pathname !== '/recipelist' || u.username !== 'recipelist' || u.search || u.hash || e.PORT !== '3000' || !['127.0.0.1','0.0.0.0'].includes(e.HOST)) {
 console.error('Update requires the managed local database, port 3000 and supported bind address.'); process.exit(1);
}
JS
  OPERATION_STARTED=true
  git_safe -C "$APP" fetch --prune origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
  CANDIDATES=()
  for candidate in "refs/remotes/origin/$REF" "refs/tags/$REF"; do
    if TARGET=$(git_safe -C "$APP" rev-parse --verify "$candidate^{commit}" 2>/dev/null); then CANDIDATES+=("$TARGET"); fi
  done
  if [[ "$REF" =~ ^[0-9a-fA-F]{40}$ ]] && TARGET=$(git_safe -C "$APP" rev-parse --verify "$REF^{commit}" 2>/dev/null); then CANDIDATES+=("$TARGET"); fi
  (( ${#CANDIDATES[@]} == 1 )) || die 'Ref is missing or ambiguous; specify a unique branch/tag or full commit ID.'
  # Validate and stage the selected unit before stopping RecipeList. Git show
  # reads the resolved immutable commit, so build scripts cannot alter it.
  UNIT_TMP=$(mktemp /etc/systemd/system/.recipelist.service.XXXXXX)
  git_safe -C "$APP" show "${CANDIDATES[0]}:deploy/lxc/recipelist.service" > "$UNIT_TMP"
  chown root:root "$UNIT_TMP"
  chmod 0644 "$UNIT_TMP"
  validate_service_unit "$UNIT_TMP"
  prepare_backup_directory
  printf 'Stopping RecipeList to create and verify a private database backup; no code changes will occur until verification succeeds.\n'
  if systemctl is-active --quiet recipelist; then SERVICE_WAS_ACTIVE=true; else SERVICE_WAS_ACTIVE=false; fi
  STOPPED=true
  if systemctl stop recipelist; then :; else backup_failure 'could not stop RecipeList for backup'; fi
  if BACKUP=$(runuser -u postgres -- mktemp "/var/backups/recipelist/recipelist-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.dump"); then :; else backup_failure 'could not create the private dump file'; fi
  [[ -f "$BACKUP" && ! -L "$BACKUP" && $(stat -c '%U:%G:%a' "$BACKUP") == postgres:postgres:600 ]] || backup_failure 'the dump file is not a private PostgreSQL-owned file'
  if pg_run "$PG_DUMP" --host=/var/run/postgresql --port=5432 --username=postgres --format=custom --dbname=recipelist --file="$BACKUP"; then :; else backup_failure 'pg_dump failed'; fi
  [[ -s "$BACKUP" ]] || backup_failure 'the database dump is empty'
  if pg_run "$PG_RESTORE" --list "$BACKUP" >/dev/null; then :; else backup_failure 'pg_restore --list could not read the dump'; fi
  printf 'Verified archive: %s (archive verification is not a restore test).\n' "$BACKUP"
  printf 'Checking out target and rebuilding while RecipeList remains stopped; migrations do not roll back automatically.\n'
  git_safe -C "$APP" checkout --detach "${CANDIDATES[0]}"
  UNIT_SOURCE=$APP/deploy/lxc/recipelist.service
  assert_root_path "$UNIT_SOURCE" file
  [[ -f "$UNIT_SOURCE" && ! -L "$UNIT_SOURCE" && $(stat -c '%u' "$UNIT_SOURCE") == 0 ]] || die 'Target checkout service unit must be a regular root-owned file.'
  cmp -s "$UNIT_SOURCE" "$UNIT_TMP" || die 'Checked-out service unit differs from the validated target commit.'
  # The validated copy is outside the checkout before any build script runs.
  build
  if ! cmp -s "$UNIT_TMP" "$UNIT"; then
    mv -fT -- "$UNIT_TMP" "$UNIT"
    UNIT_TMP=
    systemctl daemon-reload
    assert_no_unit_dropins
  else
    rm -f -- "$UNIT_TMP"
    UNIT_TMP=
  fi
  systemctl start recipelist
  health
  STOPPED=false
  printf 'Update complete. Retain archive: %s\n' "$BACKUP"
fi
