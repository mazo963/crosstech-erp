#!/bin/bash
# タイムスタンプの再検証（監査・調査対応用）。DBに保存したトークンと元のファイルを、OpenSSL で検証する。
#   使い方: scripts/verify_timestamp.sh <トークン(base64を保存したファイル)> <元のファイル> <TSAのCA証明書(PEM)>
#   例: psql -At -c "select timestamp_token_base64('<document_timestampsのid>')" | scripts/verify_timestamp.sh - 請求書.pdf tsa_ca.pem
# 「Verification: OK」と出れば、(1) トークンの署名が正しい (2) 証明書がCAに連なる (3) ファイルのハッシュが一致、が確認できる。
# 認定された時刻認証事業者のCA証明書は、事業者から入手すること。
set -euo pipefail
[ $# -eq 3 ] || { sed -n '2,7p' "$0"; exit 2; }
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
if [ "$1" = "-" ]; then base64 -d > "$tmp"; else base64 -d < "$1" > "$tmp"; fi
openssl ts -verify -in "$tmp" -token_in -data "$2" -CAfile "$3"
