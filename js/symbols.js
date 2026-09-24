// 銘柄追加時の検索候補 (ここに無い銘柄もコード/ティッカーを直接入力すれば追加できます)
// [シンボル, 名前, 検索用の別名]
export const SUGGEST = [
  // 日本株
  ['7203.T', 'トヨタ自動車', 'toyota'], ['6758.T', 'ソニーグループ', 'sony'], ['9984.T', 'ソフトバンクグループ', 'softbank sbg'],
  ['8035.T', '東京エレクトロン', 'tel tokyo electron'], ['6857.T', 'アドバンテスト', 'advantest'], ['6861.T', 'キーエンス', 'keyence'],
  ['9983.T', 'ファーストリテイリング', 'ユニクロ uniqlo'], ['8306.T', '三菱UFJフィナンシャル・グループ', 'mufg'], ['8316.T', '三井住友フィナンシャルグループ', 'smfg'],
  ['8411.T', 'みずほフィナンシャルグループ', 'mizuho'], ['6501.T', '日立製作所', 'hitachi'], ['7974.T', '任天堂', 'nintendo'],
  ['9432.T', 'NTT', '日本電信電話'], ['9433.T', 'KDDI', 'au'], ['9434.T', 'ソフトバンク', 'softbank'],
  ['4063.T', '信越化学工業', 'shinetsu'], ['6920.T', 'レーザーテック', 'lasertec'], ['6146.T', 'ディスコ', 'disco'],
  ['285A.T', 'キオクシアホールディングス', 'kioxia'], ['6723.T', 'ルネサスエレクトロニクス', 'renesas'], ['6526.T', 'ソシオネクスト', 'socionext'],
  ['3436.T', 'SUMCO', 'sumco'], ['4062.T', 'イビデン', 'ibiden'], ['7735.T', 'SCREENホールディングス', 'screen'],
  ['6963.T', 'ローム', 'rohm'], ['6981.T', '村田製作所', 'murata'], ['6762.T', 'TDK', 'tdk'],
  ['5803.T', 'フジクラ', 'fujikura'], ['7911.T', 'TOPPANホールディングス', 'toppan 凸版'], ['6702.T', '富士通', 'fujitsu'],
  ['6701.T', 'NEC', '日本電気'], ['6503.T', '三菱電機', 'mitsubishi electric'], ['7751.T', 'キヤノン', 'canon'],
  ['7741.T', 'HOYA', 'hoya'], ['6954.T', 'ファナック', 'fanuc'], ['6273.T', 'SMC', 'smc'], ['6367.T', 'ダイキン工業', 'daikin'],
  ['7267.T', '本田技研工業', 'honda ホンダ'], ['7011.T', '三菱重工業', 'mhi'], ['7012.T', '川崎重工業', 'kawasaki'], ['7013.T', 'IHI', 'ihi'],
  ['8058.T', '三菱商事', 'mitsubishi corp'], ['8031.T', '三井物産', 'mitsui'], ['8001.T', '伊藤忠商事', 'itochu'],
  ['6098.T', 'リクルートホールディングス', 'recruit'], ['4502.T', '武田薬品工業', 'takeda'], ['4568.T', '第一三共', 'daiichi sankyo'],
  ['4519.T', '中外製薬', 'chugai'], ['4661.T', 'オリエンタルランド', 'ディズニー olc'], ['2914.T', 'JT', '日本たばこ産業'],
  ['9101.T', '日本郵船', 'nyk'], ['9104.T', '商船三井', 'mol'], ['5401.T', '日本製鉄', 'nippon steel'], ['8766.T', '東京海上ホールディングス', 'tokio marine'],
  ['4755.T', '楽天グループ', 'rakuten'], ['3382.T', 'セブン&アイ・ホールディングス', 'seven'], ['8801.T', '三井不動産', 'mitsui fudosan'],
  ['9020.T', 'JR東日本', '東日本旅客鉄道'], ['4385.T', 'メルカリ', 'mercari'], ['429A.T', 'テクセンドフォトマスク', 'tekscend photomask'],
  ['1321.T', 'NEXT FUNDS 日経225連動型ETF', 'etf 日経'], ['1306.T', 'NEXT FUNDS TOPIX連動型ETF', 'etf topix'], ['1570.T', 'NEXT FUNDS 日経平均レバレッジETF', 'etf レバ'],
  // 米国株
  ['AAPL', 'アップル', 'apple'], ['MSFT', 'マイクロソフト', 'microsoft'], ['GOOGL', 'アルファベット(グーグル)', 'google alphabet'],
  ['AMZN', 'アマゾン', 'amazon'], ['META', 'メタ・プラットフォームズ', 'facebook meta'], ['NVDA', 'エヌビディア', 'nvidia'],
  ['TSLA', 'テスラ', 'tesla'], ['AVGO', 'ブロードコム', 'broadcom'], ['TSM', 'TSMC(台湾積体電路)', 'tsmc taiwan'],
  ['ASML', 'ASML', 'asml'], ['AMD', 'AMD', 'advanced micro devices'], ['AMAT', 'アプライド マテリアルズ', 'applied materials'],
  ['LRCX', 'ラムリサーチ', 'lam research'], ['KLAC', 'KLA', 'kla'], ['INTC', 'インテル', 'intel'], ['QCOM', 'クアルコム', 'qualcomm'],
  ['MU', 'マイクロン・テクノロジー', 'micron'], ['ARM', 'アーム・ホールディングス', 'arm'], ['MRVL', 'マーベル・テクノロジー', 'marvell'],
  ['TXN', 'テキサス・インスツルメンツ', 'texas instruments'], ['SMCI', 'スーパー・マイクロ・コンピューター', 'supermicro'],
  ['PLTR', 'パランティア', 'palantir'], ['ORCL', 'オラクル', 'oracle'], ['CRM', 'セールスフォース', 'salesforce'], ['ADBE', 'アドビ', 'adobe'],
  ['NOW', 'サービスナウ', 'servicenow'], ['SNOW', 'スノーフレイク', 'snowflake'], ['CRWD', 'クラウドストライク', 'crowdstrike'],
  ['PANW', 'パロアルトネットワークス', 'palo alto'], ['NFLX', 'ネットフリックス', 'netflix'], ['UBER', 'ウーバー', 'uber'],
  ['SHOP', 'ショッピファイ', 'shopify'], ['COIN', 'コインベース', 'coinbase'], ['MSTR', 'ストラテジー(マイクロストラテジー)', 'microstrategy'],
  ['SPCX', 'スペースX', 'spacex'], ['RKLB', 'ロケット・ラボ', 'rocket lab'], ['IONQ', 'イオンQ', 'ionq 量子'],
  ['JPM', 'JPモルガン', 'jpmorgan'], ['V', 'ビザ', 'visa'], ['MA', 'マスターカード', 'mastercard'], ['BRK-B', 'バークシャー・ハサウェイ', 'berkshire'],
  ['LLY', 'イーライリリー', 'eli lilly'], ['NVO', 'ノボ ノルディスク', 'novo nordisk'], ['UNH', 'ユナイテッドヘルス', 'unitedhealth'],
  ['WMT', 'ウォルマート', 'walmart'], ['COST', 'コストコ', 'costco'], ['KO', 'コカ・コーラ', 'coca cola'], ['PG', 'P&G', 'procter'],
  ['JNJ', 'ジョンソン&ジョンソン', 'johnson'], ['XOM', 'エクソンモービル', 'exxon'], ['DIS', 'ディズニー', 'disney'], ['NKE', 'ナイキ', 'nike'],
  ['BA', 'ボーイング', 'boeing'], ['IBM', 'IBM', 'ibm'],
  // 米国ETF
  ['SPY', 'SPDR S&P500 ETF', 'etf'], ['VOO', 'バンガード S&P500 ETF', 'etf'], ['VTI', 'バンガード 米国全株式ETF', 'etf'],
  ['VT', 'バンガード 全世界株式ETF', 'etf'], ['QQQ', 'インベスコ QQQ(ナスダック100)', 'etf nasdaq'], ['SMH', 'ヴァンエック 半導体ETF', 'etf semiconductor'],
  ['SOXL', 'Direxion 半導体ブル3倍', 'etf レバ'], ['TQQQ', 'プロシェアーズ ナスダック100 3倍', 'etf レバ'],
  // 投資信託 (協会コード + .T)
  ['0331418A.T', 'eMAXIS Slim 全世界株式(オール・カントリー)', 'オルカン 投信 ファンド'],
  ['03311187.T', 'eMAXIS Slim 米国株式(S&P500)', '投信 ファンド sp500'],
  ['9I311179.T', '楽天・全米株式インデックス・ファンド', '投信 ファンド 楽天vti'],
  // 指数・為替・商品
  ['^N225', '日経平均', 'nikkei'], ['^DJI', 'NYダウ', 'dow'], ['^GSPC', 'S&P500', 'sp500'], ['^IXIC', 'NASDAQ総合', 'nasdaq'],
  ['^NDX', 'NASDAQ100', 'nasdaq100'], ['^SOX', 'SOX(フィラデルフィア半導体株指数)', 'semiconductor'], ['^VIX', 'VIX', 'vix'],
  ['^HSI', '香港ハンセン指数', 'hang seng'], ['000001.SS', '上海総合指数', 'shanghai'], ['^GDAXI', 'ドイツDAX', 'dax'], ['^FTSE', '英FTSE100', 'ftse'],
  ['JPY=X', 'ドル/円', 'usdjpy'], ['EURJPY=X', 'ユーロ/円', 'eurjpy'], ['GBPJPY=X', 'ポンド/円', 'gbpjpy'], ['AUDJPY=X', '豪ドル/円', 'audjpy'],
  ['EURUSD=X', 'ユーロ/ドル', 'eurusd'], ['GC=F', '金先物', 'gold ゴールド'], ['SI=F', '銀先物', 'silver'], ['CL=F', 'WTI原油', 'oil'],
  ['BTC-JPY', 'ビットコイン(円)', 'bitcoin'], ['ETH-JPY', 'イーサリアム(円)', 'ethereum'],
];

const kana = (s) => s.toLowerCase().normalize('NFKC').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

export function searchSymbols(q, limit = 12) {
  const n = kana(q.trim());
  if (!n) return [];
  const scored = [];
  for (const [sym, name, alias] of SUGGEST) {
    const s = kana(sym), nm = kana(name), al = kana(alias || '');
    let score = -1;
    if (s === n || s === n + '.t') score = 100;
    else if (s.startsWith(n)) score = 80;
    else if (nm.startsWith(n)) score = 70;
    else if (nm.includes(n)) score = 50;
    else if (al.includes(n)) score = 40;
    if (score >= 0) scored.push([score, sym, name]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, sym, name]) => ({ symbol: sym, name }));
}
