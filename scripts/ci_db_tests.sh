#!/usr/bin/env bash
# CI・ローカル共通: 空のDBにマイグレーションを順に適用し、業務シナリオテストを流す。
# 使い方: PGHOST / PGUSER / PGPASSWORD / PGPORT を設定して実行（既定の DB 名は erp_test。作り直す）。
# 合格の条件: すべてのSQLが ERROR なく終わり、NG: を含む出力が無く、NOTICE の「OK」が1件以上ある。
set -uo pipefail
cd "$(dirname "$0")/.."
DB="${ERP_TEST_DB:-erp_test}"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB" -c "create database $DB" || exit 1

run() { psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$1"; }

for f in scripts/test_stub_supabase.sql supabase/migrations/*.sql; do
  run "$f" >/dev/null 2>/tmp/ci_err.txt || { echo "::error::マイグレーションの適用に失敗: $f"; cat /tmp/ci_err.txt; exit 1; }
done
echo "マイグレーション $(ls supabase/migrations/*.sql | wc -l) 本を適用しました"

# 順序に意味がある（scenario がテスト用ユーザーを作り、以降のテストが共有する）
total=0; fail=0
for t in test_scenario test_tax_rates test_received test_addressee test_doc_options test_accounting test_views test_convert; do
  out=$(run "scripts/$t.sql" 2>&1); code=$?
  ok=$(printf '%s\n' "$out" | grep -c 'NOTICE:  OK')
  total=$((total + ok))
  if [ $code -ne 0 ] || printf '%s\n' "$out" | grep -q 'NG:'; then
    echo "::error::$t が失敗しました（OK $ok 件の後）"; printf '%s\n' "$out" | grep -E 'ERROR|NG:|DETAIL|CONTEXT' | head -20; fail=1
  else
    echo "$t: OK $ok 件"
  fi
done
echo "合計 OK $total 件"
[ $fail -eq 0 ] && [ $total -gt 0 ]
