# FilePort

自分専用のファイル転送サービス。GitHub Pages(画面) + Supabase(DB / Storage / API)で動きます。

## 仕組み

```
ブラウザ(GitHub Pages) ──POST──> Supabase Edge Function "api"  ← Service Role Key はここだけ
        │                          ├─ 検証(形式/容量/回数/パスワード) → DB(transfers/files/downloads)
        └─ 署名付きURLで直接 ──────> Storage(非公開バケット "fileport")
```
- ブラウザは DB・Storage に**直接アクセスできません**(RLS有効・ポリシーなし・バケット非公開)。
- アップロード: `create`で検証→**ファイルごとの署名付きアップロードURL**(推測不能・約2時間で失効)を受け取り→進捗付きで保存→`finish`で実サイズを再検証して確定。
- ダウンロード: `download`で期限・パスワード・回数を確認→**60秒有効の署名付きURL**を発行。
- 削除・履歴: アップロード時に発行される「管理トークン」(この端末のlocalStorageに保存、サーバーにはハッシュのみ)で本人確認。
- 自動削除: pg_cronが30分ごとに期限切れを削除(期限切れ後はダウンロード不可なのでその間も安全)。

段階別: 1=upload/create/finish/download、2=QR・パスワード・期限、3=履歴・削除、4=RLS・レート制限・ロックアウト・mime制限、をすべて含みます。

## 手順

### 1. Supabaseプロジェクト作成
1. https://supabase.com でサインアップ → **New project**(無料プラン、リージョンは Northeast Asia (Tokyo))。
2. **Project Settings → API** で次の2つを控える:
   - **Project URL**(`https://xxxx.supabase.co` の `xxxx` が project ref)
   - **anon / publishable key**(公開してOK。**service_role は絶対にコピーしない**)

### 2. DBとStorageを作る
**SQL Editor → New query** に `supabase/schema.sql` を全部貼って **Run**。

### 3. Edge Functionをデプロイ
**方法A(CLI・推奨)**
```bash
npm i -g supabase            # または brew install supabase/tap/supabase
supabase login
supabase link --project-ref xxxx
supabase secrets set CRON_SECRET=$(openssl rand -hex 24) UPLOAD_KEY=好きな合言葉 ALLOWED_ORIGIN=https://あなたのID.github.io
supabase functions deploy api --no-verify-jwt
```
- `CRON_SECRET` の値はメモしておく(手順5で使用)。
- `UPLOAD_KEY` は任意。設定すると**合言葉を知っている人だけ**がアップロードできます(自分専用ならおすすめ)。不要なら省略。
- `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` は Supabase が自動で関数に注入します(自分で設定不要)。

**方法B(ブラウザのみ)**: Dashboard → Edge Functions → **Deploy a new function** → 名前 `api` → `supabase/functions/api/index.ts` を貼り付けてデプロイ → 関数設定で **Verify JWT をOFF**。Secretsは Edge Functions → Secrets から追加。

### 4. フロントの設定
`docs/config.js` の `SUPABASE_URL` と `SUPABASE_ANON_KEY` を書き換える。

### 5. 自動削除を有効化
`supabase/cron.sql` の `YOUR-PROJECT-REF` と `YOUR_CRON_SECRET` を置換して SQL Editor で Run。

### 6. GitHub Pagesで公開
1. GitHubで新規リポジトリ作成(例 `fileport`)。
2. このフォルダで:
   ```bash
   git init && git add . && git commit -m "FilePort"
   git branch -M main
   git remote add origin https://github.com/あなたのID/fileport.git
   git push -u origin main
   ```
3. リポジトリ **Settings → Pages → Branch: `main` / フォルダ: `/docs`** → Save。
4. 数分後 `https://あなたのID.github.io/fileport/` で公開。以降は **push するたびに自動更新**。

> `config.js` に入るのは公開前提の値のみ。`ALLOWED_ORIGIN` を自分のPagesのURLにしておけば、他サイトからのAPI利用も防げます。

### 7. 動作確認
iPhoneでファイルを送る → 表示されたURL/QRをPC・タブレットで開く → 保存できればOK。ブラウザを閉じても、期限までStorageに残ります。

## 制限値(`supabase/functions/api/index.ts` の `LIM`)
| 項目 | 初期値 |
|---|---|
| 1ファイル | 50MB(無料プランのStorage上限) |
| 1回の転送 | 10個 / 合計100MB |
| 1日あたり(同一IP) | 10回 / 300MB |
| 1リンクのDL回数 | 100回 |
| パスワード誤り | 5回で15分ロック |

変更後は `supabase functions deploy api --no-verify-jwt` を再実行。50MBを超えるには有料プラン+SQLの`file_size_limit`変更が必要です。形式を増やす場合は `MIME` と `schema.sql` の `allowed_mime_types` の両方に追加。

## 知っておくこと
- 履歴・削除権限は**その端末のブラウザ**に紐づきます(ログイン無しの設計)。別端末でも履歴を見たい場合は Supabase Auth の追加が必要です。ブラウザのデータを消すと管理権限を失いますが、期限で自動削除されます。
- 無料プランのSupabaseは**1週間アクセスがないと一時停止**されることがあります(Dashboardから再開可能)。Storage合計は1GBです。
- SVG/HTMLは安全のため非対応です。
