# mikaki OIDC 接続

tsudoi の主催者ログインと初期管理者作成は mikaki OIDC を使用します。主催者用の tsudoi Passkey 登録・ログイン API は提供しません。参加者のチケット用 Passkey は独立した機能として残ります。メールアドレスによるアカウント自動統合は行いません。

実装は mikaki リポジトリの `docs/rp-integration.md` にある Authorization Code + PKCE S256、ES256 `private_key_jwt`、ID Token 検証、`/session/check` に対応します。mikaki の Passkey や SSO cookie は tsudoi に渡りません。tsudoi の既存 `RP_ID` は tsudoi 自身の WebAuthn 用であり、OIDC の `client_id` とは別です。

## RP 登録の準備

staging と production には別々の mikaki client と P-256 鍵を用意します。mikaki 運用者に環境名、RP 名、希望する UUIDv4 `client_id`、tsudoi のホスト名を `sector_identifier` として、以下の callback URL と署名用**公開**JWK（`kty=EC`, `crv=P-256`, `x`, `y`, `kid`）を渡します。

```text
https://<tsudoi の環境別ホスト>/api/oidc/callback
```

秘密 JWK の `d` は運用者へ渡さず、tsudoi Worker の `OIDC_PRIVATE_JWK` secret に保存します。登録操作は mikaki 運用者が行います。登録形式と鍵・redirect 更新手順は mikaki の `docs/rp-client-operations.md` にあります。実ドメイン、client ID、鍵が確定するまで本番登録はできません。

登録資料は `node scripts/oidc-registration.mjs https://<ホスト> <新しい秘密ディレクトリ> <kid>` で作れます。`registration.json` だけを mikaki 運用者に渡し、`private.jwk` と `bootstrap-token.txt` はアクセスを制限して保管します。生成済みディレクトリへの上書きはしません。

## tsudoi の設定

1. `.env.staging.example` または `.env.production.example` を対応する `.local` ファイルにコピーし、`APP_ORIGIN` を公開 HTTPS origin、`OIDC_ISSUER` を `https://mikaki.tossa.app`、`OIDC_CLIENT_ID` と `OIDC_KEY_ID` を登録値にします。`APP_ORIGIN` のホストと登録済み callback のホストを一致させます。
2. 対応環境の D1 に `0002_oidc_rp.sql` を適用します。新しい Worker を配備する前に migration を適用してください。既存組織を初期化する環境では、空の新しい D1 を割り当てると旧データを保持したまま切り替えられます。
3. 対応する Worker に `OIDC_PRIVATE_JWK` と `OIDC_BOOTSTRAP_TOKEN` を secret として登録します。たとえば production は `node scripts/wrangler-env.mjs production secret put OIDC_PRIVATE_JWK` と `node scripts/wrangler-env.mjs production secret put OIDC_BOOTSTRAP_TOKEN` を実行し、各プロンプトに値を入力します。秘密 JWK は `d` を含む P-256 JWK の JSON、初期設定コードは十分長いランダム値です。`.env.*.local` や `wrangler.jsonc` にこれらを書きません。
4. Worker をデプロイします。`GET /api/oidc/status` が `{ "enabled": true }` を返すことを確認します。空の D1 では初期設定画面にコードを入力して mikaki でログインすると、その mikaki `sub` に対応する最初の組織と owner が原子的に作成されます。コードを知らないユーザーは初期管理者になれません。

公開設定だけでは OIDC は有効になりません。`OIDC_CLIENT_ID`、`OIDC_KEY_ID`、秘密鍵 secret、HTTPS `APP_ORIGIN` が揃い、issuer が固定値と一致した場合にボタンが表示されます。ローカルの HTTP 開発環境では無効です。初期管理者を作成したら、初期設定コードの secret を削除しても通常ログインは継続できます。

## 動作と確認

ログイン開始時に tsudoi はブラウザ cookie に結び付けた一回限りの取引を D1 に保存し、`state`、`nonce`、PKCE verifier を生成します。callback は issuer、state、ブラウザ、期限を検証して取引を一つの Worker に確保します。code を一度だけ交換し、ID Token の署名・issuer・audience・nonce・時刻を検証します。次に mikaki の `/session/check` で `sid`、`sub`、`auth_time` を確認してから、tsudoi の host 限定 cookie を発行します。

OIDC セッションの保護対象リクエストは、mikaki が返す lease が切れた場合に再照会します。mikaki に接続できず確認期限を更新できない場合は保護対象の処理を停止します。tsudoi のログアウトは tsudoi セッションを失効させます。mikaki 本番には現時点でログアウト通知 endpoint がないため、mikaki 側の失効は `/session/check` の期限で反映します。

受入確認では、初期設定コードなしの owner 作成拒否、最初の OIDC owner 作成、二人目の未登録者の拒否、再ログイン、state・nonce・PKCE・署名・issuer・audience の拒否、callback の再実行、複数タブ、mikaki 側失効、mikaki 一時障害、確認期限境界を確認します。RP 登録だけで接続完了とは扱いません。
