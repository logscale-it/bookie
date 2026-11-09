#!/usr/bin/env bash
# scripts/release-check.sh
#
# Release safety checks used by .github/workflows/release.yml. Also runnable
# locally (needs gh, jq, and for `assets` a logged-in gh).
#
#   scripts/release-check.sh versions vX.Y.Z
#       Tag format is valid and equals the version in package.json,
#       src-tauri/Cargo.toml and src-tauri/tauri.conf.json.
#
#   scripts/release-check.sh assets vX.Y.Z RELEASE_ID
#       GitHub release RELEASE_ID holds every installer and updater signature
#       for both platforms, and its latest.json (updater manifest) lists
#       windows and macOS with signatures and download URLs that point at
#       assets that really exist. Exists because a published release is
#       immutable: a release missing a platform can never be repaired, and the
#       tag name is lost for good.
set -euo pipefail

die() { echo "release-check: $*" >&2; exit 1; }

cmd="${1:-}"
tag="${2:-}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "tag must look like vX.Y.Z, got '${tag}'"
ver="${tag#v}"

case "$cmd" in
versions)
    cd "$(git rev-parse --show-toplevel)"
    pkg="$(jq -r .version package.json)"
    tauri="$(jq -r .version src-tauri/tauri.conf.json)"
    cargo="$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)"
    for pair in "package.json=$pkg" "src-tauri/tauri.conf.json=$tauri" "src-tauri/Cargo.toml=$cargo"; do
        [[ "${pair#*=}" == "$ver" ]] || die "${pair%%=*} has version '${pair#*=}', tag is '$tag'"
    done
    echo "versions ok: $tag"
    ;;

assets)
    id="${3:-}"
    [[ "$id" =~ ^[0-9]+$ ]] || die "assets needs a numeric release id"
    repo="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
    release="$(gh api "repos/$repo/releases/$id")"

    [[ "$(jq -r .tag_name <<<"$release")" == "$tag" ]] || die "release $id is not for tag $tag"

    # File names produced by tauri-action for this project's bundle targets.
    expected=(
        "bookie_${ver}_aarch64.dmg"
        "bookie_aarch64.app.tar.gz" "bookie_aarch64.app.tar.gz.sig"
        "bookie_${ver}_x64_en-US.msi" "bookie_${ver}_x64_en-US.msi.sig"
        "bookie_${ver}_x64-setup.exe" "bookie_${ver}_x64-setup.exe.sig"
        "latest.json"
        # Version-free copies for the website's direct download links (release.yml).
        "bookie_aarch64.dmg" "bookie_x64_en-US.msi"
    )
    names="$(jq -r '.assets[].name' <<<"$release")"
    missing=()
    for f in "${expected[@]}"; do
        grep -Fxq -- "$f" <<<"$names" || missing+=("$f")
    done
    ((${#missing[@]} == 0)) || die "release $id is missing: ${missing[*]}"

    asset_id="$(jq -r '.assets[] | select(.name=="latest.json") | .id' <<<"$release")"
    manifest="$(gh api -H "Accept: application/octet-stream" "repos/$repo/releases/assets/$asset_id")"

    [[ "$(jq -r .version <<<"$manifest")" == "$ver" ]] || die "latest.json version is not $ver"
    for p in windows-x86_64 darwin-aarch64; do
        jq -e --arg p "$p" '.platforms[$p] | (.url // "") != "" and (.signature // "") != ""' <<<"$manifest" >/dev/null \
            || die "latest.json has no usable '$p' entry (platform lost in a merge race?)"
    done
    while read -r url; do
        [[ "$url" == *"/releases/download/${tag}/"* ]] || die "latest.json url '$url' is not under /releases/download/${tag}/ (tagName missing in tauri-action?)"
        grep -Fxq -- "${url##*/}" <<<"$names" || die "latest.json points at '${url##*/}', which is not in the release"
    done < <(jq -r '.platforms[].url' <<<"$manifest")

    echo "assets ok: release $id has all ${#expected[@]} files and a complete latest.json"
    ;;

*)
    die "usage: release-check.sh versions TAG | assets TAG RELEASE_ID"
    ;;
esac
