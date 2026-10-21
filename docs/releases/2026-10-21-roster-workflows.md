# 名簿運用機能の本番反映（2026-10-21）

ユーザーの指示により、追加マイグレーションを先に適用し、検証済みの名簿運用機能を本番へ配置した。

## レビュー修正の再配置（22:46 JST）

[PR #12](https://github.com/masanork/tsudoi/pull/12)の自動レビューで、追加項目が103個以上ある名簿の表示列CSVが400応答になる問題を確認した。出力列数の検証を、取込専用の107列上限からイベントの実際の列数へ変更した。重複列と未定義列は引き続き拒否する。103項目を持つ108列のCSVで、修正前の失敗と修正後の列順・最終回答を回帰テストで確認した。

| 項目 | 記録 |
| --- | --- |
| 配置元 | Git commit `6fa76058dbf2f0d84bbd2de12e9546b8a5fe71dd` |
| active version | `2f712d70-c69f-4580-b0c3-eb3ea11b046d`、100%配信 |
| deployment作成日時 | 2026-10-21 13:46:16 UTC / 22:46:16 JST |
| version作成日時 | 2026-10-21 13:46:15 UTC / 22:46:15 JST |
| 直前version | `7f01b803-9245-42f6-b1fa-45fdb06f9a2c` |
| CI | [Codebase Health run 39610406565](https://github.com/masanork/tsudoi/actions/runs/39610406565)成功。build、型チェック、通常12件、Worker/D1 95件、運用4件、Chromium受入5件 |
| DB・設定 | 追加migrationなし。`0001`〜`0008` 適用済み・未適用なしを再確認し、配置前後の全10 bindingが一致 |
| 配置後 | 同じ本番Workerのworkers.dev URLで公開7チェックと、専用検証組織による108列CSVの8確認が成功 |
| 後処理 | 検証セッションを失効し、検証イベントをアーカイブ。未失効セッション0、未アーカイブイベント0を照合。メール送信なし |

108列の確認には、表示列順と最終項目の回答保持、重複列・未定義列の拒否を含む。既存の組織や参加者は変更していない。配信versionと完全commitのannotationを照合し、本番設定のdry-run後に配置した。

再CIで、廃止項目の名称が名簿の列設定とフォーム設定の2か所に表示される際、受入テストが対象を一意に選べない問題も見つかった。確認対象をフォーム設定の領域に限定し、ローカルの該当フローと上記CIで成功した。タイムアウトやアサーションは弱めていない。

PR #12はmain向けに作成済みだが、この記録時点では未マージ。実機・実メール等の残確認と、CLIから公開ドメインへ到達できない制約は下記のまま。

## 初回配置（15:24 JST）

| 項目 | 記録 |
| --- | --- |
| 公開URL | https://tsudoi.tossa.app |
| 配置元 | `feat/roster-workflows-20261021`、Git commit `0723aaa39272d31d8375cfc87558b4daf8460366` |
| Worker | `tsudoi` |
| active version | `7f01b803-9245-42f6-b1fa-45fdb06f9a2c`、100%配信 |
| deployment作成日時 | 2026-10-21 06:24:26 UTC / 15:24:26 JST |
| version作成日時 | 2026-10-21 06:24:24 UTC / 15:24:24 JST |
| tag / message | `0723aaa` / 完全commitとmigration `0001`〜`0008` の照合を記録 |
| 直前version | `e6227e46-f2dc-4c5f-b27d-6a92d1ce7b12`（PR9、commit `4018bcd`） |
| 配置ツール | Wrangler 4.136.0 |
| DB | `0008_roster_workflows.sql` を適用。履歴 `0001`〜`0008`、未適用なし |
| 実スキーマ | `form_fields.revision`（INTEGER、NOT NULL、既定0）、`roster_views`、`form_templates` を照合 |
| 既存設定 | 配置前後の全bindingが一致。APP_ORIGIN、RP_ID `tossa.app`、既存DB/KV/R2/Queue、送信者を維持 |

配置前に作業ツリーがcleanであること、本番設定の既存リソースがactive versionのbindingと一致することを確認した。Time Travelの復旧用ブックマークを非公開のローカルファイルに保存し、本番設定でbuildとdeploy dry-runが成功してから適用した。既存の参加者・チケット・回答はマイグレーションで書き換えていない。

初回配置はユーザーが承認したfeature branchのcommitから行い、その時点ではmainへの統合・新しいリモートCIの実行は行っていない。初回のローカル型チェック、Worker/D1 94件、通常12件、運用4件、Chromium受入5件の検証は[実装記録](../roster-workflows.md)を参照する。

## 初回配置後の確認

| 確認 | 結果 |
| --- | --- |
| 配置identity | deployment一覧で新versionへの100%配信を確認。versionのtag/messageと配置元の完全commitが一致 |
| 画面資材 | 配置先のJS・CSS・Service WorkerのSHA-256がローカルbuildと一致 |
| 公開ドメイン | Chromeでログイン画面、`/api/health` の `{"ok":true}`、OAuth issuer / authorization endpointが本番originを指すことを確認 |
| 公開ドメインの新画面 | Chromeで `/assets/index-DPMN4Yk3.js` と `/assets/index-B9Exwx_w.css` の読込参照が本番buildと一致 |
| workers.dev公開チェック | 同じ本番Workerの `https://tsudoi.masanork.workers.dev` でhealth・SPA・JS/CSS・OAuth metadata・MCP未認証拒否の7チェック成功 |
| 本番の新API | 専用の検証組織と15分有効のowner/viewerセッションで35確認成功 |
| 後処理 | 検証セッションを失効し、検証イベントを閉鎖・アーカイブ。有効な検証セッション0、未アーカイブの検証イベント0をDBで確認 |

新APIの確認には、項目の変更・廃止・再開、既存回答の保持、管理者専用項目のviewerへの非開示、利用者別の列保存、2人の所属と回答の一括更新、同じrevisionの再送拒否、絞り込みと表示列を使うCSV出力、別イベントへの項目テンプレートの適用、日程調整なしのメール宛先プレビューを含む。メールアドレスを登録しない検証データだけを使い、メールは送信していない。既存の組織・イベント・参加者は変更していない。

CLIから公開ドメインへのTLS接続は配置前からリセットされ、公開ドメインを対象にしたCLI preflightは完了していない。Chromeから同ドメインへの応答は正常であり、CLIから到達可能な同じ本番Workerのworkers.dev URLで7チェックと新APIを確認した。最初の検証用seedはD1のfile import経路の通信で失敗し、DBに検証組織が作られていないことを照合した後、D1 command経路で新しい検証データを作成して確認を完走した。

preflightのcommit/version引数は操作者入力であり、それだけを配置identityの根拠にしていない。identityは別途Wranglerのdeployment履歴・version metadataと照合した。rawログ、復旧ブックマーク、環境設定、検証用識別子は非公開の `.wrangler/releases/` に保持し、認証トークンの生値は保存・記録していない。

## 残る実利用確認と復旧

本番の新API確認は検証用セッションによるもので、実利用者のPasskeyログイン、実端末のカメラ・紙印刷・通信断復旧、実メール到達、実OAuth/MCPクライアントを確認したものではない。

不具合時は直前versionへWorkerを戻し、`0008` の追加列・テーブルとその記録を保持する。DBを落とすdown migrationは実行しない。オフライン端末の未同期操作・キャッシュの引継ぎは[既存ランブック](../deployment-runbook.md)に従う。ブラウザーの保存領域をこの配置作業で消去していない。
