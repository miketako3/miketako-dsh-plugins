# miketako-dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）で長いタスクを走らせるための、独立した 3 つの Cordis プラグインです。

長いタスクは「長いプロンプト」ではありません。ターンをまたいで生き残る実行状態、忘れてはいけない文脈、計画・実装・検証で変わるべきモデル選択という 3 つの問題を、それぞれ別のプラグインとして扱います。

| プラグイン | 解決する問題 | 既存プラグインの置き換え |
| --- | --- | --- |
| [`dsh-plugin-durable-exec`](plugins/durable-exec) | プロセス再起動で実行中の仕事が消え、副作用が二重実行される。 | なし（実行台帳とチェックポイントを追加） |
| [`dsh-plugin-context-longevity`](plugins/context-longevity) | 大量のツール定義を毎回送ってしまい、圧縮で正確なパスやコマンドが消える。 | 任意で `compaction-basic` を構造化圧縮に置換 |
| [`dsh-plugin-virtual-router`](plugins/virtual-router) | 常に同じモデルを使い、安いモデルや強いモデルを使い分けられない。 | なし（仮想プロバイダと仮想モデルを登録） |

3 つとも MIT、DSH と Node 標準ライブラリ以外の実行時依存なし、DSH の追記専用セッション履歴を書き換えません。

## 必要環境

- DSH `>=0.2.2-rc.1 <0.3.0`（`0.2.2-rc.5` で検証）
- Node.js `>=24.9.0`（`24.22.1` で検証）
- `pnpm` 11.x
- 任意: `litellm` など、DSH に登録済みのプロバイダ

npm には公開していません。clone または tarball からインストールします。

## インストール

```bash
git clone https://github.com/miketako3/miketako-dsh-plugins.git
cd miketako-dsh-plugins
pnpm install
pnpm build
dsh plugin --profile my-profile add /absolute/path/to/miketako-dsh-plugins/plugins/durable-exec
```

`dsh plugin add` はパッケージの `dsh.bundle.patch` を読み、プロファイルの patch に行を追加します。DSH をソース checkout から動かしている場合は、グローバルの `dsh` ではなくその checkout で `pnpm dsh` を実行してください。

プロファイルが `autoInstallPeers: false` の場合、`dsh plugin add` は peer 依存を自動導入しません。DSH 本体が持つ `@deepseek-ai/cordis`、`dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-tools`、compaction パッケージが見えるようにしてください。これらは DSH ホストが読み込む実体と同じコピーに解決される必要があります。`@deepseek-ai/cordis` や `@deepseek-ai/dsh-agent` を二重に導入するとサービス同一性が壊れます。

ソース checkout から DSH を動かしている場合、ホストが読み込むコピーは `apps/cli/node_modules/@deepseek-ai` です。プロファイルから見えないときは、そのディレクトリを参照できるようにしてください。

## 1. Durable execution

**パッケージ:** `dsh-plugin-durable-exec`  
**Cordis 名:** `durable-exec`  
**サービス:** `ctx.durableExec`

ツール呼び出しの前に台帳へ `PENDING` を書き、結果が出たら `COMPLETED` / `FAILED` を書きます。台帳は Node 標準の `node:sqlite` による SQLite（WAL）で、ネイティブモジュールのビルドは不要です。

- 冪等キー: `(sessionId, turn, step, toolName, sha256(正規化した引数))`。モデルが生成する `callId` は、同じ呼び出しを再発行すると変わるため含めません。
- 副作用分類: `read-only` / `idempotent` / `side-effect`。未知のツールは安全側の `side-effect`。
- 再試行: `read-only` と `idempotent` のみ。指数バックオフ、ジッター、provider の `retryAfter` に対応。
- サーキットブレーカー: 8 連続失敗で開放。`escalate` なら `ctx.virtualRouter.escalate()`、未導入ならターン停止。
- クラッシュ復帰: 起動時に `RUNNING` チェックポイントを探し、実行中だった呼び出しを `TOOL_OUTCOME_UNKNOWN` に確定してから、最大 3 セッションを `durable-resume` で再開。
- チェックポイント: `turn/start`、各 step、`turn/end` で turn・step・ゴール・Git HEAD・ワークスペース進捗を保存。

```yaml
- id: durable-exec
  config:
    databasePath: /Users/you/.dsh/durable-exec/ledger.db
    retry: { maxAttempts: 3 }
    circuitBreaker: { failureThreshold: 8, action: escalate }
    autoResume: { enabled: true, maxSessions: 3, maxAttempts: 3 }
```

台帳はツール引数と結果を含むため、セッションログと同じ機密性で扱ってください。ファイルは `0600` で作成します。

## 2. Context longevity

**パッケージ:** `dsh-plugin-context-longevity`  
**Cordis 名:** `context-longevity`（遅延ツール・キャッシュウォーム）と `context-longevity/compaction`（構造化圧縮）

### 遅延ツールロード

グローバルなツール数が `threshold`（既定 20）を超えると、常時表示のコアと、`discover_tools` / `activate_tools` で読み込むツールに分けます。有効化状態はメッセージ履歴ではなくプラグイン状態なので、圧縮後も維持されます。

27 ツールの実環境で `12 visible, 15 deferred` を確認し、`activate_tools` 後に次の step から呼び出せることを確認しました。

制限は `agent.ctx.tools.restrict({ allow })` で行い、レジストリからツールを削除しません。エージェント自身のスコープに登録されたツールは制限の対象外です。

```yaml
- id: context-longevity
  config:
    deferredTools:
      enabled: true
      threshold: 20
      maxActive: 28
```

### 構造化圧縮

`context-longevity/compaction` は DSH の `BasicCompactionEngine` を継承します。要約リクエストに明示的な出力契約を追加し、モデルが落とした事実を決定的に補います。

- 必須見出し: Primary Request and Intent / Decisions and Constraints / Files and Code / Verification / Open Issues / Next Step
- ツール引数と authored メッセージから拾ったファイルパス（最大 40）
- ツール引数から拾ったシェルコマンド（最大 10）
- 必須見出しが欠けた場合だけ `## Retained Facts` を追加

基本エンジンの設定は未知キーを拒否するため、圧縮エンジンは**別ローダー行**にします。

```yaml
- id: compaction-basic
  disabled: true
- id: compaction-longevity
  name: dsh-plugin-context-longevity/compaction
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    auto: true
```

`dsh plugin add` で入るのは `context-longevity` の行だけです。プロファイル patch で `compaction-basic` を無効化し、上の行を追加してください。

> **Web プロファイル:** Web アプリはエージェントプリセットごとに compaction 行を持ちます（`packages/bundle/web-app/presets/*.patch.yml`、id は `compaction-basic`）。使用するプリセット側で無効化してください。トップレベルの置換は headless/base にしか効きません。

### キャッシュウォーム

既定では無効です。`delayMs` を超えるツール実行中に、同じ system prompt・tools・メッセージ接頭辞で 1 トークンのリクエストを送り、次の step の prefix cache を温めます。PTC のネスト呼び出しでは動かず、ツールが返るとキャンセルします。

```yaml
- id: context-longevity
  config:
    cacheWarming:
      enabled: true
      delayMs: 2000
      intervalMs: 60000
      maxWarmingsPerTurn: 3
```

トークンと費用を使うため、既定ではオフです。

## 3. Virtual model router

**パッケージ:** `dsh-plugin-virtual-router`  
**Cordis 名:** `virtual-router`  
**プロバイダ ID:** `virtual`（変更可）  
**サービス:** `ctx.virtualRouter`

`LlmAdapter` を登録し、`virtual/autonomous` のような仮想モデルをリクエスト時に実ルートへ解決します。優先順位は、予算停止/降格 → 明示 tier → 失敗エスカレーション → フェーズ規則 → モデルの `defaultTier` です。

同じターン内は選択ルートを固定（sticky）し、ターン境界で解除します。コンテンツ開始前のプロバイダエラーだけフォールバックし、開始後のエラーは部分出力を捨てないため表面化します。

```yaml
- id: litellm
  config:
    baseUrl: http://127.0.0.1:4000
    apiKey: ${LITELLM_API_KEY}

- id: virtual-router
  config:
    provider: virtual
    models:
      - id: autonomous
        name: Autonomous
        contextWindow: 262144
        defaultTier: cheap
    tiers:
      - { id: cheap, provider: litellm, model: gpt-4.1-mini }
      - { id: strong, provider: litellm, model: gpt-4.1, reasoningEffort: high }
    phaseRoutes: { plan: strong, implement: cheap, verify: cheap, default: cheap }
    escalation: { enabled: true, afterFailures: 2, ladder: [cheap, strong] }
    fallback:
      enabled: true
      routes: [{ provider: litellm, model: gpt-4.1 }]
    budget: { maxTokens: 2000000, maxRequests: 400, onExhausted: stop }

- id: agent-default-model
  config: { provider: virtual, model: autonomous }
```

監査ログは 1 決定 1 行の JSONL で、メッセージ本文は記録しません。`auditPath` を空にするとファイル出力だけを無効化します。ファイルは `0600` で作成します。

## 3 つを同時に使う

```yaml
- id: durable-exec
- id: context-longevity
- id: virtual-router
- id: agent-default-model
  config: { provider: virtual, model: autonomous }
```

依存は緩く、`durable-exec` は `ctx.get('virtualRouter')` があるときだけエスカレーションに使い、`context-longevity` と `virtual-router` は互いを import しません。3 つともセッションログには独自イベントを追記しないため、stock DSH でセッションを読めます。

## fork の変更とプラグイン化

個人 fork の変更のうち、プラグインで表現できるのはこの 3 つだけです。

| fork の変更 | プラグイン化 | 理由 |
| --- | --- | --- |
| モバイル Web レイアウト（CSS modules、`AppFrame`、`InputBar`、`Rows`） | 不可 | CSS module のクラス名はビルド時にハッシュ化され、レイアウト変更は TSX の構造変更を含む。CSS 注入では安定して対象にできない。 |
| `DSH_WEB_NOAUTH=1` | 不可 | プロファイルやプラグインより前の HTTP サーバ起動時に読まれる。 |
| トークン単位 logprobs ストリーミング | 不可 | `@earendil-works/pi-ai` とアダプタのプロトコル変更（`patches/`）。 |
| HTTP プロキシの長時間リクエスト timeout | 不可 | プラグイン有効化前にプロキシが導入される。 |
| Durable execution / 遅延ツール / 構造化圧縮 / ルーティング | **可能** | このリポジトリの 3 プラグイン。 |

モバイルレイアウトが必要なら fork を使ってください。このリポジトリは fork の再現を主張しません。

## 開発

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

各プラグインは `plugins/` 配下の独立パッケージです。テストは Vitest と実際の `node:sqlite` を使い、台帳をモックしません。ルータのテストは偽の `LlmAdapter` でルーティング、エスカレーション、フォールバック、予算停止、sticky をネットワークなしで検証します。

## 制限

- `dsh plugin add` はプロファイル設定によって peer を自動導入しません。
- 構造化圧縮は別ローダー行で、手動で `compaction-basic` を無効化する必要があります。
- Web プリセットはそれぞれ compaction 行を持つため、トップレベルの置換だけでは足りません。
- 自動再開は best-effort です。headless プロセスは再開ターン完了前に終了することがあり、次回起動で `autoResume.maxAttempts` まで再試行します。
- 台帳はツール引数と結果をそのまま保存します。秘密情報を含み得るため、DSH home と台帳ファイルを保護してください。
- キャッシュウォームは既定でオフで、トークン費用がかかります。

## ライセンス

MIT。[LICENSE](LICENSE) を参照してください。
