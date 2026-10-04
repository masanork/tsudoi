# 2026-10-05 本番反映記録

PR4までの変更を `https://tsudoi.tossa.app` に反映した。司令塔が対象照合・migration・配置、実装者がHTTP確認コマンドと運用手順、独立レビュワーが確認コマンド・テスト・手順を担当した。実メール受信と本人確認リンクは確認済み。実機・実AIクライアントは未確認。

| 項目 | 記録 |
| --- | --- |
| Git commit | `6bde4c19ab8f65521aa9e25483d2ceebc177814d`（[PR4](https://github.com/masanork/tsudoi/pull/4)のマージcommit） |
| Worker | `tsudoi` |
| Worker version | `71dcc52b-a3db-4e4c-a54a-56ea5c98b7ef` |
| deployment作成日時 | 2026-10-04 20:53:57 UTC / 2026-10-05 05:53:57 JST |
| 配信率 | deployments listで上記versionの100%配信を確認 |
| version tag / message | `6bde4c1` / 完全commit hashとmigration0004確認を記録 |
| 実行者・ツール | Codex司令塔 / Wrangler 4.136.0（lockfileの実バージョン） |
| 直前version | `e9dbff5c-488f-4c54-ace4-393f3906a523`（元commit不明） |
| APP_ORIGIN / RP_ID | `https://tsudoi.tossa.app` / `tossa.app`を維持 |

反映対象は上記commitの独立したdetached checkoutでビルドした。作業中のPR5運用ツールは本番Workerに含めていない。既存リソース・送信者設定を照合し、Cloudflare Domains APIでcustom domainが`tsudoi` productionを指すことを確認した。route未指定の既存dashboard管理設定を維持した。

## DBと配置の確認

反映前の履歴は `0001`〜`0003`、`0004_roster_edit_import.sql`が未適用だった。既存DBのTime Travel復旧位置を取得後、コード反映前に`0004`を適用した。適用後は履歴の`0001`〜`0004`に加えて、実スキーマの`attendees.affiliation`、`attendees.revision`、`roster_import_previews`と期限indexを確認した。この配置作業中には参加者データの作成・取込・受付やメール送信を行わず、宛先許可を得た後に、後述の実メール追確認を別途行った。

versionのmessageとtag、deploymentのactive version、ビルドしたcheckoutの完全commitを別々に照合した。HTTP確認コマンドに指定したcommit/versionは操作者の記録値であり、HTTPだけで配置identityを証明したものではない。

## 確認結果

| 確認 | 結果 |
| --- | --- |
| リリース候補の自動検証 | TypeScript/Svelteエラー0・警告0、通常12件、Worker/D1 53件、Chromium E2E 5件、deploy dry-run成功（PR4時点） |
| 対象commitからの再ビルド | 成功 |
| migration / active version / commit message | 照合成功 |
| 本番HTTP確認（2026-10-04 21:03:57 UTC） | health、SPA、参照JS/CSS各1件、OAuth metadata2種、MCP未認証401の7チェック成功 |
| 本番画面の表示 | ChromeでPasskeyログイン画面を確認 |
| 主催者Passkeyログイン・名簿・受付 | 本番での認証後の操作は未確認 |
| iPhone / AndroidのPasskey・実カメラ | 未確認（仮想認証器・カメラ模擬E2Eとは区別） |
| Queueからの実メール受信・本人確認リンク・QR | 2026-10-04 21:42:13 UTCにGmailのINBOX到達。本人確認リンクの初回利用・チケット取得・再利用拒否・logout成功。QR添付の内容も発行値と照合成功（実カメラ受付は未確認） |
| 実AIクライアントのOAuth同意・MCP接続 | 未確認（metadata確認と模擬クライアント統合テストとは区別） |

ローカル本番設定ではTurnstile site keyは未設定。利用開始時には対応secretと合わせて設定・検証する。実staging環境の照合は未実施。

## 実メール追確認

送信許可された検証用宛先へ1通送信した。既存イベントを使わず、新規の専用組織・イベント（定員1、受付10分）を作成し、通常の公開登録APIを通した。登録は`201`、`emailQueued: true`。本番のQueue consumerから送られたチケットメールが、接続済みGmailの受信トレイに到着した。メールヘッダはSPF・DKIM・DMARCがいずれもpassだった。

届いた本文の本番originの本人確認リンクは、初回`302 /ticket`で参加者セッションを発行し、検証チケットの取得に成功した。再利用は`400 link_expired_or_used`で拒否され、検証セッションはlogoutした。添付`tsudoi-ticket-qr.svg`をソフトウェアで読み取り、公開登録時の受付QR URLのhashと一致した。実端末のカメラと、認証したスタッフによる実受付は別の残確認である。

専用イベントは送信直後に閉じてアーカイブし、参加者1件のみであることを確認した。検証記録は履歴として本番DBに残した。既存の参加者・イベントは変更していない。生のリンク・QR・セッショントークンは公開記録へ保存せず、検証用一時ファイルも利用後に消去した。

残る確認と次回反映は[ランブック](../deployment-runbook.md)に従う。ロールバックでも`0004`の列・テーブル・履歴を保持し、`possession-v2`チケットに対応するコードを使う。元commit不明の直前versionは互換性を確認してから選ぶ。秘密値・参加者情報・復旧位置をこの公開記録には含めない。
