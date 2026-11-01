# crosstech-erp

株式会社クロステック 統合販売管理システム（見積・受注・分納・締め請求・入金）。

- 基盤: Supabase（PostgreSQL / Auth / Edge Functions）＋ GitHub
- 仕様: [`docs/仕様書_v2.md`](docs/仕様書_v2.md)
- 作業ルールと進捗: [`CLAUDE.md`](CLAUDE.md)

## 状態（2026-11-01）

DB・Edge Function・画面・CIが実装済み。ローカルの Supabase で、ログイン・RLS・業務フロー・全画面の表示を確認済み。**Supabase のクラウド環境への適用、受注GASとの実接続、Anthropic API の実機確認は未**（CLAUDE.md §6・§7）。

## ローカルで動かして確認する（確認済み 2026-11-01）

Docker と Node 22 があれば、本物の Supabase（Auth・PostgREST・RLS）をローカルで動かして確認できます。

```bash
npx supabase start -x studio,imgproxy,vector,logflare,mailpit,realtime,storage-api,postgres-meta   # マイグレーション16本が自動で適用される
eval "$(npx supabase status -o env)"
API_URL=$API_URL ANON_KEY=$ANON_KEY SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY node scripts/smoke_supabase.mjs   # 全項目 OK なら合格
```

`scripts/smoke_supabase.mjs` は、ユーザー作成・ログイン・RLS（未登録・閲覧のみ・管理者）・見積→受注→納品→請求→入金・帳票の固定（更新・削除不可）を、実際の API で確認します。
画面を向ける場合は、`web/.env` に `VITE_SUPABASE_URL`（`API_URL`）と `VITE_SUPABASE_ANON_KEY`（`ANON_KEY`）を書いて `npm run dev`。
Edge Function は `npx supabase functions serve --env-file <secretのファイル>` で動かせます（secret のファイルはコミットしない）。

## 本番（Supabase のクラウド）のセットアップ（手順。**クラウドでの実施は未確認**）

1. Supabase でプロジェクトを作成する（リージョンを決める。無料プランは休止するので、`keepalive.yml` を設定するか、有料プランにする）
2. **自己登録を無効にする**: Authentication → Sign In / Providers → 「Allow new users to sign up」をオフ（**Email プロバイダ自体はオンのまま**。オフにするとログインできなくなる）。パスワードの最小長は10文字以上にする（`supabase/config.toml` と同じ設定）
3. マイグレーションを適用する
   ```bash
   npx supabase link --project-ref <プロジェクトID>
   npx supabase db push
   ```
4. 最初の管理者を作る
   - Supabase 管理画面 → Authentication → Users → ユーザーを追加（メール・パスワード）
   - SQL Editor で、そのユーザーを管理者として登録する
     ```sql
     insert into public.staff (id, name, role, worker_code)
     values ('<作成したユーザーのUUID>', '松田', 'admin', 'matsuda');
     ```
5. Edge Function をデプロイし、secret を設定する（値は Supabase の secret にだけ保存し、コミットしない）
   ```bash
   npx supabase functions deploy ai-extract
   npx supabase functions deploy juchu-sync
   npx supabase functions deploy timestamp
   npx supabase secrets set ANTHROPIC_API_KEY=... AI_MODEL_DEFAULT=... AI_MODEL_ADVANCED=... AI_MONTHLY_TOKEN_LIMIT=...
   npx supabase secrets set JUCHU_GAS_URL=...        # 受注GASのURL
   npx supabase secrets set TSA_URL=... TSA_NAME=... TSA_AUTH=...   # タイムスタンプ事業者と契約してから
   ```
6. 画面の設定を作る: `web/.env.example` を `web/.env` にコピーし、`VITE_SUPABASE_URL` と `VITE_SUPABASE_ANON_KEY`（Settings → API の anon キー。**service_role キーは入れない**）を書く
7. 画面の「設定」で、自社情報（登録番号・住所など）、振込先の口座、ロゴ・社印を入力する
8. GitHub の Variables / Secrets を設定する（`keepalive.yml` と `deploy.yml`。後述）

## ローカルでのDB検証

CLAUDE.md §5 を参照。

## 自動実行（GitHub Actions）

- `ci.yml`: push・PR のたびに、DBの業務シナリオテストと、単体テスト・型チェック・画面のビルド
- `keepalive.yml`: 毎日 `ping` を呼び、Supabase の休止を防ぐ（Variables `SUPABASE_URL`、Secrets `SUPABASE_ANON_KEY` が必要）
- `deploy.yml`: 画面を GitHub Pages に配信（手動実行のみ。Variables `VITE_SUPABASE_URL`、Secrets `VITE_SUPABASE_ANON_KEY` が必要）

## 秘密情報

service_role キー、Anthropic APIキー、受注GASのURLは**コミットしない**。Supabase の secrets と GitHub Actions の secrets に保存する。
