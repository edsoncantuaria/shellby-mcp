#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
source_commit="3929c99a97d1aa0fb8000903a4b57b24fbabe742"
source_repository="https://github.com/openai/codex.git"
case "$(uname -m)" in
  x86_64) architecture=x64 ;;
  aarch64) architecture=arm64 ;;
  *) echo "Linux apply_patch supports x86_64 and aarch64 only." >&2; exit 1 ;;
esac
if [[ "$(uname -s)" != Linux ]]; then
  echo "This builder is for Linux only; use the existing macOS vendor builder on macOS." >&2
  exit 1
fi
for command in cargo git rustc sha256sum strip; do
  command -v "$command" >/dev/null || { echo "Required command missing: $command" >&2; exit 1; }
done

temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT
source_root="${1:-$temporary_root/codex}"
if [[ $# -eq 0 ]]; then
  git clone --filter=blob:none --no-checkout "$source_repository" "$source_root"
  git -C "$source_root" checkout --detach "$source_commit"
fi
if [[ "$(git -C "$source_root" rev-parse HEAD)" != "$source_commit" ]]; then
  echo "Codex source must be checked out at $source_commit." >&2
  exit 1
fi

CARGO_TARGET_DIR="$temporary_root/target" cargo build \
  --manifest-path "$source_root/codex-rs/Cargo.toml" \
  --package codex-apply-patch --bin apply_patch --release
binary="$temporary_root/target/release/apply_patch"
vendor_dir="$repo_root/vendor/apply-patch/linux-$architecture"
mkdir -p "$vendor_dir"
install -m 0755 "$binary" "$vendor_dir/apply_patch"
strip "$vendor_dir/apply_patch"
sha256sum "$vendor_dir/apply_patch" > "$vendor_dir/apply_patch.sha256"
printf 'Source: %s\nCommit: %s\nBuild: cargo build --manifest-path codex-rs/Cargo.toml --package codex-apply-patch --bin apply_patch --release\n' \
  "$source_repository" "$source_commit" > "$vendor_dir/provenance.txt"
echo "Built $vendor_dir/apply_patch"
