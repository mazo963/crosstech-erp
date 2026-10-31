# CLAUDE.md — CROSSTECH 統合販売管理システム（crosstech-erp）

このファイルは Claude Code が最初に読む作業ルールと引継ぎです。**回答・コメント・ドキュメントは日本語**で書くこと。

## 1. このシステムは何か

株式会社クロステック（ワイヤー放電加工）の **見積 → 受注 → 分納 → 締め請求 → 入金** を管理する販売管理システム。
仕様の全体は `docs/仕様書_v2.md`（v2.1。実装状況を各機能に併記）。元の構想は `docs/元仕様_crosstech_erp.md`（問題点を含むため、仕様は v2 を正とする）。

## 2. 決定事項（2026-10-30 確定）

| 項目 | 決定 |
|---|---|
| 技術基盤 | **Supabase**（PostgreSQL・Auth・Edge Functions）＋ **GitHub**（ソース管理・Actions） |
| 画面 | Vite + React + TypeScript（`web/`）。静的サイトとしてホスティング |
| MFとの関係 | **当面は併用し、後で決める**。ERPは控え・社内用の帳票まで。正式なインボイスはMFで発行し、MFの番号を `invoices.mf_invoice_no` に控える |
| 受注・生産管理システム（既存 HTML＋GAS＋Drive） | **ERPが親、受注は加工現場用に残す**。案件・製番はERPで1回だけ登録。受注システムからは、加工完了・出荷の進捗を製番（`product_no`）で**読み取りのみ**同期する |
| AI（Sonnet / Haiku） | **システム内のAI機能**として使う。見積依頼メール・注文書PDFから案件の下書きを作る。既定は Haiku、PDF・難しい入力は Sonnet。**AIの結果は必ず人が確認してから保存**（自動保存しない） |

## 3. 絶対に守るルール

1. **金額計算と整合性チェックはDB（SQL関数・トリガー）で行う。** 画面側で金額を計算して保存しない。
2. 金額は円の整数（`numeric(14,0)`）。行金額は円未満切捨て。消費税は**請求書1枚・税率ごとに1回**だけ端数処理する（インボイス要件）。
3. 帳票・納品・請求・入金は**削除しない**。取消（`voided` / `status='void'`）で残す。
4. **秘密情報をコミットしない**：Supabase の service_role キー、Anthropic APIキー、受注GASのURL、パスワード。`.env` は `.gitignore` 済み。公開してよいのは Supabase の URL と anon キーだけ。
5. 共通キーは社内製番 `product_no`（例: `CRO261001-3`）。名前や意味を変える前に、ハブ（claude.ai Project「社内運用管理システム」）の意思決定ログで決める。
6. 1ファイルは小さく保つ（目安300行以内）。Sonnet / Haiku でも正確に改修できるようにするため。
7. スキーマ変更は**新しいマイグレーションファイルを追加**する（既存ファイルは書き換えない。本番適用後は特に）。
8. **帳票は必ず `issue_document` で発行し、固定した内容から印刷する。** 発行済み帳票（`issued_documents`）・交付記録・送付PDFは更新・削除しない（訂正は取消＋新しい版）。電子帳簿保存法の方針と要確認事項は `docs/電帳法対応方針.md`。
9. **スキーマ・機能を変えたら、`docs/システム概要書.md`（構成・データの流れ・変更履歴）を同じ変更で更新する。** 自社開発システムは、電子帳簿保存法上、システム関係書類の備付けが必要（一覧は `docs/システム関係書類一覧.md`）。

## 4. ディレクトリ

```
supabase/migrations/   DB定義（テーブル・関数・ビュー・RLS）
supabase/functions/    Edge Functions（ai-extract, juchu-sync）※未作成
web/                   画面（Vite + React + TS）※未作成
scripts/               ローカル検証用SQL
docs/                  仕様書・設計メモ
.github/workflows/     CI・デプロイ・休止防止 ※未作成
```

## 5. DBの検証方法（ローカル、Supabase不要）

PostgreSQL 15以上で、Supabase の auth スキーマを再現する `scripts/test_stub_supabase.sql` を先に流し、その後マイグレーションと業務シナリオテストを流す。

```bash
createdb erp_test
for f in scripts/test_stub_supabase.sql supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d erp_test -f "$f" || break; done
psql -d erp_test -f scripts/test_scenario.sql   # NOTICE に「OK ...」が並べば合格。「NG」で止まれば不合格
psql -d erp_test -f scripts/test_tax_rates.sql  # 複数税率
psql -d erp_test -f scripts/test_received.sql   # 受領書類・スキャナ保存・タイムスタンプ
node --experimental-strip-types --test supabase/functions/*/*.test.ts web/src/lib/*.test.ts   # Edge Function・CSV/ZIPの単体テスト（OpenSSLがあれば本物のタイムスタンプ応答も検証）
```

Supabase CLI を使う場合は `supabase start` → `supabase db reset` でも同じマイグレーションが適用される。

## 6. 進捗

### 完了
- [x] DBスキーマ（`supabase/migrations/` の4本）
  - 01 テーブル：自社情報、スタッフ、得意先、外注先、案件、品目、納品・納品行、請求・請求行、入金・消込、外注仕入、AI取込ログ、操作ログ
  - 02 関数：採番（`CRO2610xx` / `DN2610-0001` / `INV2610-0001`）、分納（`record_delivery`）、納品取消、締め請求（`create_invoice`）、発行・取消、入金の自動消込（`record_payment`）、支払期日・締め期間の計算
  - 03 ビュー：品目進捗、未請求の納品行、案件サマリ（粗利・進捗）、請求残高、得意先残高、ダッシュボード
  - 04 RLS：admin / office / viewer。スタッフ未登録のユーザーと anon は業務データに触れない
- [x] 05 入金の銀行情報・取消（`20261031000005`）：`payments` に入金銀行・口座番号・取消の列、`record_payment` を銀行振込で銀行・口座必須に作り直し、`void_payment` を追加。残高ビューは取消済み入金を除外。ローカルのシナリオテスト全項目合格（2026-10-31）
- [x] 06 帳票の発行・固定（`20261031000006`）：`issued_documents`（内容・SHA-256・版・検索項目）、`document_deliveries`（交付記録）、`document_files`（送付PDF）、`issue_document` / `attach_document_pdf`。更新・削除は特権ロールでも不可、元の請求書・納品の取消で帳票も取消。`company_settings.erp_invoice_official`（MFが正式の間は false）
- [x] 07 複数税率（`20261101000007`）：税区分・期間つき税率・納品日時点の税率固定・税率別の請求と帳票。`set_tax_rate`（管理者のみ、さかのぼり不可）。**将来の税率（飲食料品1%）は未登録**（令和9年4月1日〜令和11年3月31日の予定。法案成立の確認後に画面の「税率」から登録。手順は `docs/電帳法対応方針.md` §7）
- [x] 08 受領書類とタイムスタンプ（`20261101000008`）：電子取引・スキャナ保存の登録（`register_received_document`、読取条件・入力期限・ハッシュをDBが確認）、取消のみ可・更新削除不可、`document_timestamps`（RFC 3161）、`v_timestamp_status`
- [x] 09 国税庁の一次資料に基づく修正（`20261101000009`）：暦の2か月、重要書類のカラー必須、入力期間を過ぎた重要書類は紙の原本保存（`paper_original_required`）、帳簿への紐づけは登録後に追記（`received_document_links`）、税区分に新聞の定期購読を追加
- [x] Edge Function `timestamp`（RFC 3161の要求・応答の解析はOpenSSLの本物の応答でテスト済み）。**認定事業者のTSAは未契約**（secret `TSA_URL` / `TSA_NAME` / `TSA_AUTH` 未設定のため付与は保留）。`scripts/verify_timestamp.sh` で再検証。**法令上は「総務大臣が認定する時刻認証業務」のものが必要**
- [x] テスト: `scripts/test_scenario.sql`・`test_tax_rates.sql`・`test_received.sql`（2026-10-31 全項目合格。一次資料に合わせた修正を含む）、`supabase/functions/*/` の単体テスト
- [x] 10 ダウンロードの求めへの出力（`20261101000010`、画面「出力」）：出力用ビュー、一覧CSV（受領書類・発行済み帳票・送付PDF）、ファイル本体のZIP（SHA-256の照合つき）。国税庁 電子取引 問59
- [x] システム概要書（`docs/システム概要書.md`）と、備付け書類の対応表（`docs/システム関係書類一覧.md`）。**操作マニュアルと事務手続の書類は未作成**、仕様書は v2.1 に更新済み（実装状況の列つき）
- [x] 業務シナリオテスト（`scripts/test_scenario.sql`）全項目合格（2026-10-31。入金取消・帳票発行の項目を追加。以降の機能は上のテストファイルに分けた）


### 残作業（この順で進める）
1. [x] **Edge Function `ai-extract`**（実装・単体テスト合格 2026-10-30。Deno/Supabase 上での実機確認は未）：メール本文 / 注文書PDF → 案件下書きJSON。Anthropic Messages API を tool use で構造化出力。モデルは環境変数 `AI_MODEL_DEFAULT`（Haiku）/ `AI_MODEL_ADVANCED`（Sonnet）で切替（モデルIDはコードに直書きしない）。`ai_extractions` にトークン数を記録し、`AI_MONTHLY_TOKEN_LIMIT` 超過で停止。ユーザーのJWTでDBに接続し、RLSを効かせる
2. [x] **Edge Function `juchu-sync`**（実装・単体テスト合格 2026-10-30。実GASのJSON形式・Supabase上での確認は未）：受注GASの doGet（受注JSON配列）を取得 → `items[].productNo` で照合 → `project_items.juchu_completed_at / juchu_shipped_date / juchu_synced_at` を更新。GAS URL は Supabase の secret `JUCHU_GAS_URL`。受注側へは書き込まない
3. [ ] **画面 `web/`**（ログイン・スタッフ確認・ダッシュボード・得意先/外注先マスタ・案件（品目行・AI取込）・分納記録・締め請求（作成/発行/取消）・入金登録（銀行・口座番号、取消）・帳票（発行・固定・印刷・検索・交付記録・送付PDF保存）・受領書類（電子取引・スキャナ保存・タイムスタンプ状況）・税率まで実装、ビルド成功 2026-10-30。以下の残りは未実装）：ログイン（Supabase Auth。固定の admin/crosstech は使わない）、ダッシュボード、得意先・外注先マスタ、案件（品目行・AI取込ボタン）、分納記録、締め請求の作成・発行、入金登録、メール作成（mailto でTO/CC/件名/本文を自動入力）、設定（自社情報・スタッフ）
4. [ ] **GitHub Actions**：
   - CI：PostgreSQL サービスで §5 のテストを実行、`web/` のビルド
   - デプロイ：`web/` の静的ビルド
   - 休止防止：毎日 `rpc/ping` を呼ぶ（Supabase 無料プランは、7日間の利用が少ないと休止する）
5. [ ] `README.md` のセットアップ手順を、実際に動かして確認する
6. [ ] ハブ（claude.ai Project）へ変更点レポートを戻し、システム台帳・データ契約・意思決定ログを更新する

## 7. 未決事項（ユーザーに確認が必要。勝手に決めない）

- 社内製番の採番ルール：既存の ARCHAIVE / 受注システムの製番（`CRO261001-3` 形式）と一致するか。ERPの自動採番を正とするか、既存の発番を手入力するか
- ホスティング先：**このリポジトリは現在 public**。private にする場合、GitHub Pages は有料プラン（Pro 以上）が必要。代替として Cloudflare Pages / Netlify（受注システムでデプロイ回数上限の課題あり）
- MF併用の終わらせ方（ERPでの正式インボイス発行に切り替えるか）
- 外注仕入の支払管理をどこまでやるか（支払予定表・振込データ作成まで必要か）
- 受注システムの「加工完了 → 納品処理ToDo」を、ERPの分納記録とどうつなぐか（二重入力にしない）
- 在宅ワーク管理ダッシュボードが、将来ERPのデータを読むか
- **電子帳簿保存法**（`docs/電帳法対応方針.md`。国税庁の一次資料で確認済み、出典は §9）：**総務大臣認定のタイムスタンプ事業者の選定・契約**（スキャナ保存は実質必須。受領した電子取引は、タイムスタンプか事務処理規程が必要。自社システムの「訂正削除不可」だけでは足りない）。**システム概要書・操作説明書・事務手続の書類が未作成**（自社開発のため必要）。事務処理規程の要否、業務処理サイクル方式（最長2か月）を使うか。送付PDFの自動保存が未了。バックアップは法令上の要件ではないが、7年保存のため強く推奨
- **飲食料品の税率引下げ（1%）**：国税庁の令和8年9月資料では、**令和9年4月1日から令和11年3月31日まで**（来年1月ではない）。「法案が成立した場合」の内容なので、**成立を確認してから**画面の「税率」で登録する。経過措置（定期供給契約・通信販売は8%のまま）への対応設計は、内容が確定してから

## 8. 関連

- ハブ：claude.ai Project「社内運用管理システム」（運用ルール、システム台帳、意思決定ログ、データ契約）
- 受注・生産管理システム：HTML（Netlify）＋GAS＋Drive `juchu_data.json`。ERPからは読み取りのみ
- 外部SaaS：ARCHAIVE（図面・案件）、マネーフォワードクラウド請求書（正式帳票）
