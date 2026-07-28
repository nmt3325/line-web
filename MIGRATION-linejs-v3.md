# linejs v3 追従メモ（自動調査＋修正）

対象コミット: `line-web-main.zip`（添付）／linejs 側の参照バージョン: **v3.2.1**（2026-07-13 リリース）

## 1. 何が起きていたか

`package.json` は `@evex/linejs` を `npm:@jsr/evex__linejs@^2.3.7` に固定していました。
その間に linejs は **v3.0 → v3.2.1** まで進み、`line-web` 側で「バグ」として実装されていた
ワークアラウンドの多くが、**上流で既に修正済み**になっています。

### v2.3 以降で効いてくる主な修正・変更

| バージョン | 内容 | line-web への影響 |
| --- | --- | --- |
| v3.0 / v3.1.0 | `@evex/linejs/call` 追加、compact message 対応、login helper が `version` / `endpoint` を透過 | 破壊的変更なし（Client / login factory の形は同じ） |
| v3.1.2 | Android primary / V3 トークン向けに **LEGY `/enc` 暗号化トランスポートを自動化**。`loginWithAuthToken` が V3 credential JSON（`accessToken` / `refreshToken` / `expire`）を受け付ける | トークン保存を「文字列だけ」から credential 形式へ拡張する必要あり |
| v3.1.4 | **Thrift I64（bigint）の書き込みバグ修正**。messageId 等が hex 解釈されて壊れ、`MESSAGE_NOT_FOUND` になっていた | `getPreviousMessagesV2WithRequest` の `endMessageId` を Number へ丸める「3候補総当たり」ハックが不要に |
| v3.1.5 | QR ログイン後の **E2EE 鍵不一致を検証して自動再登録**（GCM の "Unsupported state or unable to authenticate data" の原因）。`e2ee:keyMismatch` イベント追加 | 復号エラー時の再ログイン運用が不要に。イベントを観測ログへ |
| v3.1.6 | TMoreCompactProtocol の **zigzag デコード修正**（数字だけのメッセージが +1〜+3 ずれる） | 受信テキストのずれが解消 |
| v3.1.7 | 1:1 通話の T103 タイムアウト修正 | 通話未実装なので影響なし |
| v3.2.0 | Square（OpenChat）への画像/動画/音声送信、VOOM ノートのメディアアップロード | 将来の拡張余地 |
| v3.2.1 | `relation` の友だち追加リクエストのシリアライズ修正 | 友だち追加を実装する場合に必要 |

また `ClientInit` に **`legy: { encrypted, endpoint }`** が追加されています（既定 `auto`）。

### API の生存確認（v3.2.1 のソースで確認済み）

- `talk.getContacts({ mids })` … **存在する**（`packages/linejs/base/service/talk/mod.ts`）
- `talk.getRecentMessagesV2({ messageBoxId, messagesCount })` … **存在する**（初回ロード向けの新ヘルパー）
- `talk.noop()` … 存在する。`ConnManager._OnPingCallback` が ping 3 回ごとに自動呼び出し
- `base.createPolling()` … 存在する（`this.poll` を返すだけ）
- `Polling._listenTalkEvents()` / `_listenSquareEvents()` … **`@deprecated`**（talk.sync ポーリング）
- `Polling.listenTalkEvents()` … LEGY push (`/PUSH/1/subs`) の `ReadableStream<Operation>` を返す推奨経路
- `push.conns[]` の `Conn` は **`close()`** を持つ（`connManager` 自身も `conns[0].close()` を使用）
- `Client.listen()` / `client.on("message" | "event" | "square:message" | ...)` も利用可能

## 2. このコミットで入れた修正

### package.json
- `@evex/linejs` を `npm:@jsr/evex__linejs@^3.2.1` へ更新。

### server.js
1. **ログイン初期化の共通化**: `loginInit(session)` を追加し、`device` を `LINE_DEVICE`
   環境変数で切り替え可能にしたうえで `legy: { encrypted: "auto" }` を明示。
   password / QR / authToken の 3 経路すべてで共通化。
2. **v3 credential の永続化**: `persistAuthCredential()` / `loadAuthCredential()` を追加。
   `refreshToken` / `expire` が storage にある場合は `.auth` に JSON で保存し、
   復元時はそのまま `loginWithAuthToken` に渡す（旧形式の生トークンも後方互換）。
   `update:authtoken` でも credential ごと書き直す。
3. **メッセージ初回ロードの総当たり撤去**: `endMessageId` の
   「Number(bigint)+1 / BigInt / BigInt+1n」3候補ループを削除し、
   初回は `talk.getRecentMessagesV2`、ページネーションは `BigInt` の `endMessageId` 1 回のみに。
   （v3.1.4 の I64 修正で丸めハックが不要になったため）
4. **受信ループを LEGY push 優先へ**: `@deprecated` な `_listenTalkEvents` を既定で使うのをやめ、
   `polling.listenTalkEvents()`（push ストリーム）を既定に。abort 時は `stream.cancel()`。
   3 回連続で失敗したら `talkPushDisabled` を立てて sync ポーリングへ自動退避。
   ストリームが即終了した場合の busy loop を防ぐため再接続前に 1 秒待機。
5. **E2EE メディア取得の簡素化**: `downloadMediaByE2EESmart` は、まず素の
   `obs.downloadMediaByE2EE(msg)` を試すように変更（issue #88 が上流で修正済み）。
   失敗時のみ従来の `Object.create` による候補総当たりへ退避。
6. **E2EE 復号条件の緩和**: `contentMetadata.e2eeVersion` が無くても `chunks` があれば復号を試行。
7. **送信取り消し**: `seq: 0` 固定をやめ `base.getReqseq()` の値を使用。
8. **push 切断**: `conn.close()` を優先し、旧 `reqStream.abort.abort()` はフォールバックに。
9. **MID 区切り**: システムイベントの `param3` 分割を `,` だけでなく RS(`\x1e`) にも対応。

### README.md
- 依存バージョンの記載を v3 系に更新。
- 実装に存在しない `POST /api/auth/token` の記載を修正（起動時自動復元の説明へ）。

## 3. 残っているリスク / 次にやること

- **サンドボックスにネットワークが無いため `npm install` と実機ログインの検証はできていません。**
  ローカルで `npm install`（`.npmrc` に `@jsr:registry=https://npm.jsr.io` が必要）→ `npm start` で
  ログイン・受信・メディアの動作確認をお願いします。
- LEGY push へ切り替えたため、`TALK_POLLING_INTERVAL_MS` は退避時のみ使われます。
  push が安定するなら sync ポーリング経路は将来削除できます。
- `client.listen()` + `client.on("message")` に載せ替えると自前の復号処理を削れますが、
  現状は OpType ごとのシステムメッセージ処理を自前で行っているため段階移行が安全です。
- `device: "DESKTOPWIN"` は `getContactsV3` など一部 API が使えません（現状は `talk.getContacts` を使用）。
  友だち一覧の情報量を増やしたい場合は device 変更（= 再ログイン）の検討が必要です。
- v3.2.0 の Square メディア送信、v3.2.1 の友だち追加修正は未活用。OpenChat 対応時に利用可能。
