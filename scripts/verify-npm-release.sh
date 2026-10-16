#!/usr/bin/env bash
set -euo pipefail

release_version="${1:?release version is required}"
release_dist_tag="${2:?npm dist-tag is required}"
export npm_config_registry=https://registry.npmjs.org

# npm makes a publish visible asynchronously; the launcher usually shows up
# within a minute or two.
wait_attempts=90
wait_seconds=10

published_version=""
for attempt in $(seq 1 "$wait_attempts"); do
  published_version="$(npm view "t3-hermes@${release_dist_tag}" version 2>/dev/null || true)"
  if [[ "$published_version" == "$release_version" ]]; then
    break
  fi
  sleep "$wait_seconds"
done
if [[ "$published_version" != "$release_version" ]]; then
  echo "::error::t3-hermes@${release_dist_tag} resolves to '${published_version}', expected '${release_version}'." >&2
  exit 1
fi

# Avoid the checkout's binaries, npm cache, and user state masking a broken package.
# The launcher downloads this version's CLI archive from the GitHub Release,
# which publish_cli only runs after.
smoke_dir="$(mktemp -d)"
trap 'rm -rf "$smoke_dir"' EXIT
cd "$smoke_dir"
# npm view and npm exec use different registry metadata representations. The
# tag can be visible before the abbreviated install metadata has caught up.
for attempt in {1..12}; do
  if actual_version="$(npm_config_cache="$smoke_dir/cache" npm_config_prefer_online=true T3HERMES_HOME="$smoke_dir/state" \
    npm exec --yes --package="t3-hermes@${release_version}" -- t3-hermes --version 2>"$smoke_dir/npm-error.log")"; then
    break
  else
    install_status=$?
  fi
  cat "$smoke_dir/npm-error.log" >&2
  if ! grep -Eq '^npm (error|ERR!) code (ETARGET|E404)$' "$smoke_dir/npm-error.log" || [[ "$attempt" == 12 ]]; then
    exit "$install_status"
  fi
  echo "Waiting for t3-hermes@${release_version} install metadata (attempt ${attempt}/12)." >&2
  sleep 5
done
if [[ "$actual_version" != "t3-hermes v${release_version}" ]]; then
  echo "::error::Published CLI reported '${actual_version}', expected '${release_version}'." >&2
  exit 1
fi
echo "Verified t3-hermes@${release_version} on npm tag ${release_dist_tag}."
