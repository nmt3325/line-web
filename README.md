# line-web-chat

LINE を Web で利用するための非公式チャットアプリです。  
バックエンドは `@evex/linejs` を使い、フロントエンドは `Express + Socket.IO + Vanilla JS` で構成されています。

> 注意: 本プロジェクトは LINE の**非公式クライアント**です。API 仕様変更や制限により動作が変わる可能性があります。

## 主な機能

- メールアドレス/パスワードログイン
- QR コードログイン（PIN コード入力対応）
- 保存済みトークンでの自動ログイン
- 友達一覧・グループ一覧取得
- メッセージ一覧取得、リアルタイム受信
- テキスト送信
- 画像送信/表示（E2EE 画像を含む）
- 動画送信/表示（E2EE 動画を含む）
- PWA 対応（Service Worker / Manifest）

## 技術スタック

- Node.js（ESM）
- Express
- Socket.IO
- `@evex/linejs`（v3 系。`package.json` では `npm:@jsr/evex__linejs@^3.2.1` を指定）
- Undici（HTTP/2 有効）
- QRCode

## セットアップ

```bash
npm install
```

`npm install` で `@jsr/...` の 404 が出る場合は、`.npmrc` に次の設定が必要です。

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

## ログインとセッション

- 初回ログイン後、認証トークンは `line-storage.json` に保存されます。
- 次回アクセス時に自動ログインを試行します。
- ログアウトすると、接続中のポーリングを停止し、`line-storage.json` を初期化します。

## API エンドポイント（主要）

- `GET /api/auth/status` 認証状態確認
- （未実装）トークンログインの REST エンドポイントは存在しません。保存済みトークンによる復元は起動時に自動で行われます
- `POST /api/auth/logout` ログアウト
- `GET /api/profile` 自分の MID 取得
- `GET /api/friends` 友達一覧
- `GET /api/groups` グループ一覧
- `GET /api/chat/:mid/messages?limit=30` メッセージ取得
- `POST /api/chat/:mid/send` テキスト送信
- `POST /api/chat/:mid/send-image` 画像送信
- `GET /api/message/:messageId/image` 画像取得
- `POST /api/chat/:mid/send-video` 動画送信
- `GET /api/message/:messageId/video` 動画取得

## Socket.IO イベント（主要）

受信:

- `auth:none`
- `auth:success`
- `auth:pincode`
- `auth:qrcode`
- `auth:error`
- `chat:message`

送信:

- `auth:auto`
- `auth:password`
- `auth:qr`

## デバッグ

`debug.js` で保存済みトークンを使った接続確認とメッセージ取得テストができます。

```bash
node debug.js
```

## ディレクトリ構成

- `server.js`: API + Socket.IO サーバー
- `public/`: クライアント（`index.html`, `app.js`, `style.css`, `sw.js`）
- `line-storage.json`: 認証トークン等のローカル保存
- `linejs/`: linejs ソース一式（参照用）

## 運用上の注意

- レートリミットを考慮し、短時間で過剰なリクエストを送らないでください。
- 認証情報・トークンは機密情報として扱ってください。
- `linejs/` 配下は原則変更しない運用を想定しています。

## ライセンス

必要に応じて追記してください。
