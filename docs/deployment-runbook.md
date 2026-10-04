# 本番反映・実環境確認ランブック

この手順は次回の本番反映と、実機・実メール・OAuth/MCP 確認に使う。PR4・PNGメール修正を反映後、2026-10-05 07:24 JSTにCSVプレビュー定時削除のPR6マージcommit `aeff98c071a6e00f75899d3b6064a48e8dd612e8` を反映した。本番 Worker version は `96b5207f-1128-45f9-be1f-7b67bcee1325`（100%配信）、本番DBには `0001`〜`0004` が適用済み。[反映記録](releases/2026-10-05-production.md)を参照し、次回は作業直前に状態を再取得する。

手順を実行する担当者は、本番操作の権限と時間帯を確認し、送信可能な検証用メールアドレスを用意する。実機、メール受信、実 OAuth/MCP クライアントの確認ができない場合は「未確認」と記録し、合格扱いにしない。

## 1. 対象と作業前確認

1. `main` に PR4 のマージ commit `6bde4c1`、PNGメール修正commit `19500e0`、CSVプレビュー定時削除のPR6マージcommit `aeff98c` が含まれていることを確認し、作業ツリーが clean であることを確認する。

   ```bash
   git switch main
   git pull --ff-only
   git status --short
   git log -1 --format='%H %s'
   git merge-base --is-ancestor 6bde4c1 HEAD
   git merge-base --is-ancestor 19500e0 HEAD
   git merge-base --is-ancestor aeff98c HEAD
   ```

   `git status --short` に出力がある場合は止め、対象を特定してから clean な checkout でやり直す。以降の記録には `git rev-parse HEAD` の完全な commit hash を使う。

2. `.env.production.example` を `.env.production.local` に複製し、本番の既存リソースを指す値を確認する。`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`KV_NAMESPACE_ID`、R2 bucket、Queue、route、`APP_ORIGIN`、`RP_ID`、送信者は、既存本番環境と一致させる。`EMAIL_FROM` と `EMAIL_SENDER` は同一の検証済みアドレスにする（前者は Worker の送信元表示、後者は Email binding の許可リスト）。`.env.production.local`、API token、秘密値、参加者情報をログ・チケット・公開文書へ貼り付けない。`RP_ID` は既存 Passkey を維持するため本番値 `tossa.app` を変えない。

3. Turnstileを有効にしている環境では、`TURNSTILE_SITE_KEY` が本番の公開フォーム設定と一致し、対応する `TURNSTILE_SECRET` が Wrangler secret として設定されていることを担当者が確認する。今回の本番ではsite keyは未設定。新たに有効化する場合は別途検証する。secret の値は表示・記録しない。送信元アドレスと Worker の Email binding が一致し、Queue producer/consumer が同じ本番 Queue を参照することを確認する。

4. 反映前チェックを実行する。

   ```bash
   npm ci
   npm --prefix web ci
   npm run typecheck
   npm test
   npm run test:worker
   npm run test:operations
   npm run build
   ```

   必須チェックが1つでも失敗したら進めない。ブラウザ受入テストがこのリリース候補で必要な場合は `npm run test:e2e` も実行し、結果と実機確認を混同しない。

## 2. 現DBの確認とマイグレーション

本番は既存DBなので、先に適用履歴を確認する。ラッパーは `.env.production.local` から環境別の一時 Wrangler 設定を作り、終了時に消す。

```bash
node scripts/wrangler-env.mjs production d1 migrations list DB --remote
```

この `list` は未適用ファイルの一覧であり、適用済みmigration一覧ではない。今回の反映後は `No migrations to apply!` が想定結果だが、それだけで履歴や実スキーマが正しいとは判断しない。今後の変更で新しいmigrationが増えた場合は、そのリリースの想定一覧と照合する。[Wrangler D1 migrations list の説明](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-list)

適用履歴と実スキーマを個別に読み取り確認する。次のコマンドはDB名や参加者データを出さず、migration名と `attendees` の列名だけを表示する。

```bash
node scripts/wrangler-env.mjs production d1 execute DB --remote --command "SELECT name FROM d1_migrations ORDER BY name;"
node scripts/wrangler-env.mjs production d1 execute DB --remote --command "PRAGMA table_info(attendees);"
node scripts/wrangler-env.mjs production d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='roster_import_previews';"
```

migration 履歴には `0001_initial.sql`〜`0004_roster_edit_import.sql` があり、schema には `attendees.affiliation`、`attendees.revision` と `roster_import_previews` があることを確認する。適用前に `0004` が履歴にない場合は、実スキーマに `0004` の変更がすでに存在しないことも照合する。履歴とschemaが食い違う、想定外の migration がある、または対象DBを特定できない場合は停止してDB担当者に照合する。migration ファイルを編集・再採番して履歴を合わせてはならない。

この Worker は `0004` を必要とする。今回の本番では適用済み。未適用の別環境ではコードを出す前に適用する。適用済みDBで次のコマンドを実行しても、同じmigrationを再実行しない。

```bash
npm run db:migrate:production
node scripts/wrangler-env.mjs production d1 migrations list DB --remote
node scripts/wrangler-env.mjs production d1 execute DB --remote --command "SELECT name FROM d1_migrations ORDER BY name;"
node scripts/wrangler-env.mjs production d1 execute DB --remote --command "PRAGMA table_info(attendees);"
node scripts/wrangler-env.mjs production d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='roster_import_previews';"
```

一覧が `No migrations to apply!` であることに加え、migration履歴とschemaの双方で `0004` の適用を確認する。`0004` は `attendees` に `affiliation` と `revision` を追加し、`roster_import_previews` テーブルと期限 index を追加する additive migration である。列やテーブルを落とす down migration はない。適用中のエラー、または履歴と実DBの不一致があればデプロイを止め、migration を手作業で再実行・修正しない。[D1 migrations の履歴と適用方法](https://developers.cloudflare.com/d1/reference/migrations/)

新規環境を作る場合は、先に一度デプロイして Wrangler に D1 等のリソースを作成させ、その後 `npm run db:migrate:production` を実行し、全 migration の適用を確認してからアプリの利用を始める。既存本番の順序とは異なる。

## 3. 本番デプロイと version 記録

マイグレーションの適用確認後、同じ clean な commit から本番をデプロイする。

```bash
COMMIT="$(git rev-parse HEAD)"
npm run deploy:production -- --tag "${COMMIT:0:7}" --message "Git commit: $COMMIT"
node scripts/wrangler-env.mjs production deployments list
node scripts/wrangler-env.mjs production versions view '<今回のversion ID>' --json
```

デプロイ一覧から今回の active version ID と作成時刻を記録する。記録には次を含める: UTC/JST の実行時刻、完全な Git commit hash、`git log -1 --format=%s` の要約、Worker 名、migration 適用結果、Wrangler version（`npx wrangler --version`）、active deployment version ID、実行担当者、smoke test と実機確認の結果。Cloudflare の version ID だけから Git commit を推定しない。記録先に API token、環境ファイル、参加者の氏名・メールアドレスを含めない。

Worker version と deployment は別の記録対象である。version に含まれるのは Worker code/assets/bindings/compatibility settings であり、D1/KV/R2 の状態や Git commit は自動で含まれない。上記ではcommitをmessage/tagに明示的に記録する。active versionの100%配信とversion messageのcommitを照合する。[Cloudflare Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)

### CSVプレビューの定時削除

default・staging・productionのWrangler設定に `*/5 * * * *` を定義し、5分ごとに期限切れの `roster_import_previews` を削除する。DBの現在時刻と比較して期限内のプレビューを保持し、100件ずつ最大10回（1000件）で終了する。超過分は次回以降へ繰り越す。参加者・チケット・回答・監査ログは削除しない。CronはUTCで動き、設定変更の反映には最大15分かかる場合がある。[Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

デプロイ後にWorkerのTriggers設定でCronを照合し、Workers Logs / Cron Eventsで `import_preview_cleanup` の成功と `deletedCount`、`limitReached` を確認する。`limitReached: true` は処理上限へ到達した意味で、残件の存在を確定するものではない。繰り返し上限へ達する場合や失敗が続く場合は、滞留件数を調べて処理量を見直す。本文やプレビューJSONをログへ出さない。

```bash
node scripts/wrangler-env.mjs production d1 execute DB --remote --command "SELECT COUNT(*) AS expired_count FROM roster_import_previews WHERE expires_at <= CURRENT_TIMESTAMP;"
```

新規Cronのイベント表示には時間がかかることがある。設定が存在するだけで実行成功と記録せず、確認できた範囲を反映記録に残す。HTTP経由の公開メンテナンスAPIは設けない。D1エラーはscheduled handlerから伝播し、成功ログは出さない。

デプロイ失敗、active version の特定失敗、または想定と異なる commit/version の場合は受入確認へ進まず、実行ログを保全して担当者へ連絡する。

## 4. 即時 smoke test

`.env.production.local` の `APP_ORIGIN` を用い、秘密情報を含めず基本応答を確認する。

```bash
APP_ORIGIN='https://本番ホスト名を.env.production.localから転記'
DEPLOYMENT_VERSION='直前のwrangler deployments listで確認したversion ID'
COMMIT="$(git rev-parse HEAD)"
node scripts/production-preflight.mjs --origin "$APP_ORIGIN" --deployment-version "$DEPLOYMENT_VERSION" --commit "$COMMIT" --output production-preflight.json
curl --fail --silent --show-error "$APP_ORIGIN/api/health"
curl --fail --silent --show-error "$APP_ORIGIN/.well-known/oauth-protected-resource"
curl --fail --silent --show-error "$APP_ORIGIN/.well-known/oauth-authorization-server"
```

preflight は health、SPA/static asset、OAuth metadata、MCP の未認証拒否を read-only で確認する。`passed` と各 check を確認する。`--deployment-version` と `--commit` は操作者入力の記録候補であり、CLI はデプロイ identity を HTTP 経由で照合しない（レポートの `deploymentIdentityVerified` は常に `false`）。Cloudflare dashboard / Wrangler deployment history と Git commit を人が別々に照合し、合わなければ合格扱いにしない。JSON レポートは公開リポジトリへ追加しない。

health が `{"ok":true}` を返すことを確認する。OAuth metadata は JSON として取得でき、resource/authorization endpoint が本番 origin を指すことを確認する。MCP の POST 未認証要求は `401` と Bearer challenge を返すことが期待値である。

続いて実ブラウザで本番 origin にアクセスし、主催者 Passkey ログイン、対象イベントと名簿の読込、会場選択、テスト参加者1名の受付・重複結果を確認する。実参加者を使わず、事前に用意した検証イベント・検証アカウント・検証データに限定する。CSV の実取込は本番データへ行わず、検証イベントのみで行う。

以下のどれかが失敗した場合は、それ以上の本番操作を止めて version と時刻を記録する。DB migration はそのまま保持し、後述のロールバック判断へ進む。

## 5. 実機 Passkey・カメラ確認

検証イベントと検証用アカウントを使い、iPhone の Safari と Android の Chrome でそれぞれ確認する。機種名、OS version、ブラウザ version、日時、結果、再現手順だけを記録し、参加者情報は記録しない。

- 主催者が既存 Passkey でログインできる。
- 参加者が検証フォームに申込み、Passkey を登録できる。別セッションから同じ参加者のチケットを再表示できる。
- 実カメラで QR を読み取り受付できる。同じ QR がカメラ映像に続けて映っている間は重複 POST が抑制されることを確認する。スキャナーを再開して同じ QR を改めて読み取ると、API の重複受付結果が表示されることを確認する。
- 受付を理由付きで取消し、名簿から再受付できる。
- カメラ API が使えない場合、QR URL 貼付または名簿検索から受付できる。

端末選択や権限拒否などで確認できないケースは「未確認」とする。Chromium 仮想認証器・カメラ模擬の E2E 結果で実端末を合格扱いしない。

## 6. Queue・実メール確認

送信が許可された検証用メールアドレスのみを使う。確認者は対象メールボックスへのアクセスを事前に用意し、検証イベントから本人確認メールを1通送る。送信 API の `202` / `queued` 応答は Queue 投入の確認にとどまり、配信成功を意味しない。

- Worker が Queue に enqueue したことを確認する。
- Queue consumer が処理し、受信箱（迷惑メールも含む）へ実際に到着したことを確認する。
- 本人確認リンクが正しい本番 origin を指し、リンクを1回使用でき、2回目は再使用できないことを確認する。
- HTMLメールの本文内にPNGの受付QRが表示されることを確認する。MIMEの`image/png`、`Content-ID`とHTMLの`cid:`参照だけでなく、メールクライアントでの実表示も確認する。PNGを読み取って受付URLが正しいことを照合し、検証イベントで受付できることを確かめる。旧SVG添付が読み取れても、メール内で表示できることの代替にはならない。
- Queue retry / failure があれば Cloudflare の Queue メトリクス・Worker logs で調査する。受信を確認できなければ「メール未確認」と記録し、送信成功とはしない。

メール本文、リンク、宛先を公開ログやリリースノートへコピーしない。テスト後に検証イベント・アカウントを整理する場合も、本番参加者を巻き込まないことを確認する。

## 7. 実 OAuth・MCP 確認

スケジュール連携を提供する場合、実際にサポート対象とする OAuth/MCP クライアントを使い、検証イベント・テストユーザーで行う。結合テストの模擬クライアントや protected-resource metadata の取得だけでは合格にしない。

1. クライアントに本番 MCP URL（`APP_ORIGIN` の `/mcp`）を登録し、実際のブラウザ OAuth 認可・同意を完了する。
2. 接続後に MCP `initialize` / `tools/list` を実行し、認可された読み取り・更新スコープに応じたツールが利用できることを確認する。
3. 検証用日程調整で poll を読み、空き時間または選択肢を更新して、イベント画面に反映されることを確認する。実カレンダーに意図しない招待・予定を作らない。
4. クライアントを切断または token を失効させ、以後の MCP 要求が拒否されることを確認する。

クライアント側の登録制約、同意画面、ネットワーク等で試せない場合は、どの段階まで到達したかを記録して「未確認」とする。OAuth metadata の取得だけを接続成功とみなさない。

## 8. 失敗時のロールバック

Worker の不具合なら、確認済みの直前 production version を Cloudflare の deployment rollback 機能で active に戻すか、直前の Git commit を clean checkout して同じ本番設定で再デプロイする。Wrangler の `rollback` または dashboard の Deployments > Rollback を使う。Rollback は新しい deployment を作り、storage resource 自体を巻き戻さない。[Cloudflare rollback 手順と制約](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

rollback 先が active になる前にデータ構造の互換性を確認する。どちらの方法でも戻した Git commit と active version ID を記録する。復旧後に health・metadata・ログイン・名簿・受付を再確認する。

現在の直前versionは `7586923b-24e7-4187-83df-cc2e888e32d4`（PNG修正、定時削除導入前）。Cron設定はWorker versionのrollbackでは戻らない。`scheduled()`のない版へ戻す前に対象環境のWrangler設定の `triggers.crons` を `[]` にし、`node scripts/wrangler-env.mjs production triggers deploy` で反映する。Triggers設定でCronがないことを照合し、設定変更の伝播中は旧handlerへ切り替えず、停止を確認してからWorkerをrollbackする。handler対応版を復元するまでCronを無効に保つ。PNG修正の直前versionは `71dcc52b-a3db-4e4c-a54a-56ea5c98b7ef`（PR4、SVG添付）。さらに以前のversion `e9dbff5c-488f-4c54-ace4-393f3906a523` は元commitが不明なので、互換性未確認のまま戻さない。新規 `possession-v2` チケットを扱えることを確認したコードを選ぶ。

復旧時はhandler対応版のactive配信を先に確認し、対象環境の `triggers.crons` を `["*/5 * * * *"]` に戻して `node scripts/wrangler-env.mjs production triggers deploy` を再実行する。Triggers設定と伝播後の `import_preview_cleanup` 成功ログを確認してから、定時削除の復旧を完了とする。Worker versionの切替だけでCronが再開したと判断しない。

**`0004` はロールバック時にも保持する。** migration を戻す SQL は実行せず、列・テーブル・履歴を削除しない。`0004` の追加は旧アプリとの後方互換を保つための additive schema change である。データベース migration の後戻しは Worker の rollback に含めない。将来の schema cleanup が必要なら、別リリースで利用状況を確認し、独立した計画・レビューを経て行う。

バージョン rollback 後に新コードで作成された名簿取込・所属情報のデータを旧版が読み書きする可能性がある。旧版で期待動作しないと判明した場合、データを削除・変換せず、互換コードの再デプロイまたは前進修正を選ぶ。参加者・チケット・回答・監査ログに対する手作業の変更を行わない。

## 完了記録

各項目を「合格」「失敗」「未確認」のいずれかで記録し、未確認は残件として明示する。少なくとも Git commit、Worker version、`0001`〜`0004` の migration 状態、health/metadata、主催者ログイン・名簿・受付、iOS、Android、実メール受信、実 OAuth/MCP を含める。認証情報、秘密値、メールアドレス、参加者情報は記録しない。
