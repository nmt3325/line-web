# line-web-chat

LINE を Web で利用するための非公式チャットアプリです。
バックエンドは `@evex/linejs` を使い、フロントエンドは `Express + Socket.IO + Vanilla JS` で構成されています。
**複数アカウントの同時ログイン**に対応し、受信メッセージはローカルの SQLite に永続化されます。

> ⚠️ 注意: 本プロジェクトは LINE の**非公式クライアント**です。API 仕様変更や制限により動作が変わる可能性があります。自己責任でご利用ください。

## 主な機能

### 認証・アカウント

- メールアドレス / パスワードログイン
- QR コードログイン（PIN コード入力対応）
- 保存済みトークンでの自動ログイン（起動時に順次復元）
- **複数アカウントの同時ログイン / 切り替え**
- 同一アカウント（MID）の重複ログインを自動的に解消

### メッセージ

- 友だち一覧・グループ一覧取得（未読数・最新メッセージプレビュー付き、最終受信順にソート）
- メッセージ一覧取得（**SQLite ローカルキャッシュ + ページネーション**）
- リアルタイム受信（ポーリング、切断時は自動再起動）
- テキスト送信
- 画像送信 / 表示（1 対 1 は E2EE 対応）
- 動画送信 / 表示（E2EE 対応、HTTP Range によるシーク対応）
- ボイスメッセージ（音声）表示
- ファイルダウンロード
- 既読通知・入力中（タイピング）表示・送信取り消し・メッセージ編集・リアクションの受信
- 参加 / 退出などのシステムメッセージ表示

### PWA / 通知

- PWA 対応（Service Worker / Manifest）
- Web Push によるプッシュ通知（VAPID、`web-push` はオプショナル依存）

### 堅牢性

- アカウントごとに専用の HTTP/2 コネクションプール（ロングポーリングの衝突を回避）
- 破損しても自己修復するトークンストレージ（`safe-storage.js`）

## 技術スタック

- Node.js（ESM、Node.js 20 以上を推奨）
- Express
- Socket.IO
- `@evex/linejs`
- better-sqlite3（メッセージの永続化）
- Undici（HTTP/2 有効）
- QRCode
- web-push（任意 / プッシュ通知用）

## セットアップ

```bash
npm install
```

`npm install` で `@jsr/...` の 404 が出る場合は、`.npmrc` に次の設定が必要です（本リポジトリには同梱済み）。

```ini
@jsr:registry=https://npm.jsr.io
```

## 起動

```bash
npm start
```

開発時（watch モード）:

```bash
npm run dev
```

デフォルト URL: `http://localhost:3000`

### 環境変数

- `PORT`（任意）: サーバー待受ポート（未指定時は `3000`）

デバッグ用のログイン情報は `.env` に記述します。`.env.example` をコピーして利用してください。

```bash
cp .env.example .env
```

## ログインとセッション

- ログイン後、認証トークンは各アカウントのディレクトリ（`accounts/<id>/line-storage.json`）に保存されます。
- 起動時、登録済みアカウントを保存トークンで順に自動ログインします。
- ログアウトすると、当該アカウントのポーリングを停止し、登録簿から削除します。
- 旧バージョンの単一アカウントデータ（`./line-storage.json`, `./messages.db`）は初回起動時に自動で `accounts/` へ移行されます。

## API エンドポイント（主要）

すべての `/api/*` は、対象アカウントを `X-Account-Id` ヘッダまたは `?account=<id>` クエリで指定します。

- `GET /api/accounts` アカウント一覧
- `GET /api/auth/status` 認証状態確認
- `POST /api/auth/logout` ログアウト（アカウント削除）
- `GET /api/profile` 自分のプロフィール取得
- `GET /api/friends` 友だち一覧
- `GET /api/groups` グループ一覧
- `GET /api/chat/:mid/messages?limit=30&beforeMessageId=&beforeDeliveredTime=` メッセージ取得（ページネーション対応）
- `POST /api/chat/:mid/send` テキスト送信
- `POST /api/chat/:mid/send-image` 画像送信
- `POST /api/chat/:mid/send-video` 動画送信
- `GET /api/message/:messageId/image` 画像取得
- `GET /api/message/:messageId/video` 動画取得
- `GET /api/message/:messageId/audio` 音声取得
- `GET /api/message/:messageId/file?name=<filename>` ファイル取得
- `GET /api/push/public-key` VAPID 公開鍵取得
- `POST /api/push/subscribe` プッシュ購読登録
- `POST /api/push/unsubscribe` プッシュ購読解除

## Socket.IO イベント（主要）

受信:

- `auth:none` / `auth:success` / `auth:pincode` / `auth:qrcode` / `auth:error`
- `accounts:update` アカウント一覧の更新
- `chat:message` 新着メッセージ
- `chat:read` 既読通知
- `chat:typing` 入力中
- `chat:unsend` 送信取り消し
- `chat:message-edited` メッセージ編集
- `chat:reaction` リアクション

送信:

- `accounts:list` アカウント一覧要求
- `auth:auto` 自動ログイン（互換用）
- `auth:password` パスワードログイン
- `auth:qr` QR ログイン

## ディレクトリ構成

- `server.js`: API + Socket.IO サーバー
- `account-manager.js`: 複数アカウントの登録簿とセッションのライフサイクル管理
- `message-store.js`: SQLite によるメッセージの永続化
- `safe-storage.js`: 破損に強い自己修復型のトークンストレージ
- `public/`: クライアント（`index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest`, `icons/`）
- `accounts/`: アカウントごとのデータ（`accounts.json` 登録簿 + `<id>/line-storage.json` + `<id>/messages.db`）
- `vapid.json` / `push-subscriptions.json`: プッシュ通知の鍵・購読情報（自動生成）

## 運用上の注意

- レートリミットを考慮し、短時間で過剰なリクエストを送らないでください。
- 認証情報・トークンは機密情報として扱ってください（`accounts/`, `.env`, `vapid.json` は Git 管理外です）。

## ライセンス

[MIT License](./LICENSE) の下で公開されています。
