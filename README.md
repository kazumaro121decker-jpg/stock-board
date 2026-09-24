# マイ株ボード

日経平均・為替などの主要指標、保有株(オルカン・AMAT・AMD・NVIDIA・SpaceX・Tesla・テクセンドフォトマスク)、買いを検討しているウォッチ銘柄の値動きを、スマホでもパソコンでも一目で確認できる Web アプリです。

- **ホーム**: 保有資産の評価額・本日の損益・含み損益、マーケット(日経平均/日経先物/NYダウ/S&P500/NASDAQ/SOX/VIX/ドル円/ユーロ円/ユーロドル/米10年債/金/原油/ビットコイン)、注目シグナル、ニュース
- **保有銘柄**: 評価額・損益(円換算、ドル建ては取得時の為替も考慮可)、構成比
- **ウォッチ**: 目標買値までの距離、52週レンジの位置、RSI、「売られすぎ」などのシグナル
- **詳細画面**: チャート(1日〜5年、25日/75日移動平均線)、PER・時価総額・配当・次回決算・アナリスト目標株価、テクニカル指標、銘柄ニュース、Yahoo!ファイナンス/株探/TradingView へのリンク
- **ホーム画面に追加(PWA)**: アプリのように1タップで起動。前回データを即表示し、最新データへ自動更新。オフラインでも前回の画面を表示
- 値動きの色は日本式(上昇=赤)/米国式(上昇=緑)、ライト/ダークを切り替え可能

## 仕組み

```
GitHub Actions (平日15分ごと)                GitHub Pages
  scripts/fetch_quotes.py  ──書き込み──▶  data/quotes.json  ◀──読み込み── スマホ / PC のアプリ
  (Yahoo Finance・Google ニュース)          data/watchlist.json ◀──銘柄の追加/削除── アプリ(GitHub連携)
```

- 株価は平日約15分ごと・土日3時間ごとに自動取得(Yahoo Finance、最大20分程度の遅延)。投資信託は1日1回の基準価額
- PER などの財務情報と5年チャートは12時間ごと、ニュースは1時間ごとに更新
- 保有数・取得単価・目標買値・メモは**各端末のブラウザ内だけ**に保存され、GitHub には送られません

## セットアップ(初回のみ・約10分)

1. **GitHub アカウント**を作成し、新しい **Public** リポジトリ(例: `stock-board`)を作る
   (無料プランで GitHub Pages を使うには Public が必要です。銘柄の一覧は公開されますが、保有数や金額は公開されません)
2. このフォルダの中身をリポジトリにアップロードする
3. リポジトリの **Settings → Pages** で、Source を「Deploy from a branch」、Branch を `main` / `/(root)` にして Save
4. **Actions** タブを開き、「株価データ更新」を選んで **Run workflow** で初回実行(1〜3分)
5. 数分後、`https://<ユーザー名>.github.io/stock-board/` を開くと表示されます

### スマホのホーム画面に追加

- **iPhone**: Safari で開く → 共有ボタン → 「ホーム画面に追加」
- **Android**: Chrome で開く → ︙ メニュー → 「ホーム画面に追加」/「アプリをインストール」
- **PC**: Chrome/Edge のアドレスバー右端のインストールアイコン、またはブックマーク

### 銘柄の追加・削除をアプリから行う(推奨)

アプリの **設定 → GitHub 連携** にトークンを登録すると、アプリの「＋」ボタンで追加した銘柄が株価の取得対象に自動で反映されます(端末ごとに1回)。

1. <https://github.com/settings/personal-access-tokens/new> を開く
2. Repository access: **Only select repositories** → このリポジトリ
3. Repository permissions: **Contents: Read and write**(「今すぐ株価を取得」ボタンを使う場合は **Actions: Read and write** も)
4. 作成したトークンをアプリの設定画面に貼り付けて「保存して接続テスト」

トークンを使わない場合は、`data/watchlist.json` の `symbols` に次の形式で1行追加しても同じです。

```json
{ "symbol": "7203.T", "name": "トヨタ自動車", "list": "watch", "type": "stock", "news": "トヨタ 株" }
```

| 種類 | symbol の書き方 | 例 |
|---|---|---|
| 日本株 | 証券コード + `.T` | `7203.T`, `429A.T` |
| 米国株・ETF | ティッカー | `NVDA`, `VOO` |
| 投資信託 | 協会コード(8桁) + `.T`、`"type": "fund"` | `0331418A.T` |
| 指数・為替 | Yahoo Finance の記号 | `^N225`, `JPY=X` |

`list` は `hold`(保有)か `watch`(ウォッチ)。マーケット欄の指標は `markets` で変更できます。

## うまく動かないとき

- **データが更新されない**: Actions タブで「株価データ更新」の実行結果を確認。60日間リポジトリに動きがないと GitHub が定期実行を止めることがあります(その場合は Actions タブで再度有効化)
- **Actions が push できない**: Settings → Actions → General → Workflow permissions を「Read and write permissions」に
- **銘柄が「取得できませんでした」**: コードの書き方を確認(上の表)

## ファイル構成

```
index.html / css/ / js/        アプリ本体(ビルド不要の HTML/CSS/JavaScript)
manifest.webmanifest, sw.js    ホーム画面追加・オフライン対応
data/watchlist.json            取得する銘柄の一覧
data/quotes.json               取得した株価(自動生成)
scripts/fetch_quotes.py        株価取得スクリプト
.github/workflows/             定期実行の設定
```

※ 表示される情報とシグナルは参考情報であり、投資の勧誘や助言ではありません。
