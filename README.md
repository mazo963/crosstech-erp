# crosstech-erp

株式会社クロステック 統合販売管理システム（見積・受注・分納・締め請求・入金）。

- 基盤: Supabase（PostgreSQL / Auth / Edge Functions）＋ GitHub
- 仕様: [`docs/仕様書_v2.md`](docs/仕様書_v2.md)
- 作業ルールと進捗: [`CLAUDE.md`](CLAUDE.md)

## 状態（2026-10-30）

DBスキーマと業務ロジックが完成し、ローカルで検証済み。画面・AI取込・受注連携・CIは未作成（CLAUDE.md §6）。

## セットアップ（予定・未検証）

1. Supabase でプロジェクトを作成する
2. マイグレーションを適用する
   ```bash
   npx supabase link --project-ref <プロジェクトID>
   npx supabase db push
   ```
3. 最初の管理者を作る
   - Supabase 管理画面 → Authentication → Users → ユーザーを追加
   - SQL Editor で、そのユーザーを管理者として登録する
     ```sql
     insert into public.staff (id, name, role, worker_code)
     values ('<作成したユーザーのUUID>', '松田', 'admin', 'matsuda');
     ```
4. 自社情報（登録番号・振込先など）を、画面の設定または SQL で入力する

## ローカルでのDB検証

CLAUDE.md §5 を参照。

## 自動実行（GitHub Actions）

- `ci.yml`: push・PR のたびに、DBの業務シナリオテストと、単体テスト・型チェック・画面のビルド
- `keepalive.yml`: 毎日 `ping` を呼び、Supabase の休止を防ぐ（Variables `SUPABASE_URL`、Secrets `SUPABASE_ANON_KEY` が必要）
- `deploy.yml`: 画面を GitHub Pages に配信（手動実行のみ。Variables `VITE_SUPABASE_URL`、Secrets `VITE_SUPABASE_ANON_KEY` が必要）

## 秘密情報

service_role キー、Anthropic APIキー、受注GASのURLは**コミットしない**。Supabase の secrets と GitHub Actions の secrets に保存する。
