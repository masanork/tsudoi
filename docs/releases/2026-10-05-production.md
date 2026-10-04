# 2026-10-05 本番反映記録

PR4までの変更を `https://tsudoi.tossa.app` に反映した。司令塔が対象照合・migration・配置、実装者がHTTP確認コマンドと運用手順、独立レビュワーが確認コマンド・テスト・手順を担当した。実機・メール受信・実AIクライアントは未確認。

| 項目 | 記録 |
| --- | --- |
| Git commit | `6bde4c19ab8f65521aa9e25483d2ceebc177814d`（[PR4](https://github.com/masanork/tsudoi/pull/4)のマージcommit） |
| Worker | `tsudoi` |
| Worker version | `71dcc52b-a3db-4e4c-a54a-56ea5c98b7ef` |
| deployment作成日時 | 2026-10-04 20:53:57 UTC / 2026-10-05 05:53:57 JST |
| 配信率 | deployments listで上記versionの100%配信を確認 |
| version tag / message | `6bde4c1` / 完全commit hashとmigration0004確認を記録 |
| 実行者・ツール | Codex司令塔 / Wrangler 4.135.0 |
| 直前version | `e9dbff5c-488f-4c54-ace4-393f3906a523`（元commit不明） |
| APP_ORIGIN / RP_ID | `https://tsudoi.tossa.app` / `tossa.app`を維持 |

反映対象は上記commitの独立したdetached checkoutでビルドした。作業中のPR5運用ツールは本番Workerに含めていない。既存リソース・送信者設定を照合し、Cloudflare Domains APIでcustom domainが`tsudoi` productionを指すことを確認した。route未指定の既存dashboard管理設定を維持した。

## DBと配置の確認

反映前の履歴は `0001`〜`0003`、`0004_roster_edit_import.sql`が未適用だった。既存DBのTime Travel復旧位置を取得後、コード反映前に`0004`を適用した。適用後は履歴の`0001`〜`0004`に加えて、実スキーマの`attendees.affiliation`、`attendees.revision`、`roster_import_previews`と期限indexを確認した。参加者データの作成・取込・受付や、メール送信は行っていない。

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
| Queueからの実メール受信・本人確認リンク・QR | 未確認。送信許可された検証用アドレスを未取得 |
| 実AIクライアントのOAuth同意・MCP接続 | 未確認（metadata確認と模擬クライアント統合テストとは区別） |

ローカル本番設定ではTurnstile site keyは未設定。利用開始時には対応secretと合わせて設定・検証する。実staging環境の照合は未実施。

残る確認と次回反映は[ランブック](../deployment-runbook.md)に従う。ロールバックでも`0004`の列・テーブル・履歴を保持し、`possession-v2`チケットに対応するコードを使う。元commit不明の直前versionは互換性を確認してから選ぶ。秘密値・参加者情報・復旧位置をこの公開記録には含めない。
