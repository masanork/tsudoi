# MCP Inspector による本番接続確認（2026-10-22 JST）

公式の [MCP Inspector CLI](https://github.com/modelcontextprotocol/inspector/tree/main/clients/cli) `2.12.0` を使い、同じ本番Workerの `https://tsudoi.masanork.workers.dev/mcp` へ Streamable HTTP で接続した。確認完了は2026-10-22 04:13:18 UTC / 13:13:18 JST。Worker version `2f712d70-c69f-4580-b0c3-eb3ea11b046d` の100%配信を照合してから実行した。

認証は専用の検証組織・検証イベントだけに使えるイベント専用キー。有効期間を15分に限定し、既存の組織・イベント・参加者は変更していない。実メールは送信していない。

## 確認結果

CLIの終了コードと応答内容を含む27個の自動確認が成功した。

| 操作 | 結果 |
| --- | --- |
| `initialize` | サーバー名 `tsudoi-scheduling`、protocol version `2025-11-25` を確認 |
| `tools/list` | 日程調整用の11ツールを取得 |
| `get_poll` | キーの対象イベントと未回答の選択肢を取得 |
| `update_scheduling_preferences` → `get_scheduling_preferences` | 空き時間・制約を保存し、同じ内容を再取得 |
| `submit_schedule_availability` → `get_poll` | `yes` 回答とリビジョンの更新を確認 |
| `suggest_slots` | 登録した空き時間から候補枠を取得 |
| イベント専用キーの失効 | 公開APIで失効後、Inspectorの再接続が `auth_required`（終了コード3）になることを確認 |
| 後処理 | 検証接続を失効し、検証イベントを閉鎖・アーカイブ。未失効の検証接続0、未アーカイブの検証イベント0をDBで照合 |

Inspectorはバージョンを固定して起動した。認証情報をコマンド引数や公開ファイルに含めず、設定JSONをプロセスの標準入力から渡した。Inspectorの保存先は非公開の検証用ディレクトリに分離した。キーの生値は保存せず、出力を秘匿化して記録した。検証用識別子、rawログ、JSONレポートはgit対象外の `.wrangler/releases/mcp-inspector-20261022/` に保持する。

## 残る確認

今回確認したのは、公式クライアントを使うイベント専用キーの接続・操作・失効である。ブラウザーでのOAuthログイン・同意、OAuthトークンの更新と失効、Claude等の個別クライアントでの接続は未確認。

CLIから公開ドメイン `https://tsudoi.tossa.app` へのTLS接続は引き続きリセットされる。同じ本番Workerのworkers.dev URLによる結果を、公開ドメインでのOAuth接続成功として扱わない。

Android端末はこの確認時点で未接続。実機Passkey・実カメラ・紙印刷・通信断復旧、実メール到達は未確認であり、今回のMCP結果で合格にしない。
