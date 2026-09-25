#!/usr/bin/env python3
"""株価データを取得して、アプリが読む JSON 一式を書き出すスクリプト。

GitHub Actions から定期実行される。誰でも銘柄を追加できるよう、
data/universe.json (共通の銘柄一覧) と data/watchlist.json (マーケット指標・追加銘柄)
に載っている銘柄をまとめて取得する。

出力 (--out で指定したフォルダ、既定は _site/data):
  quotes.json        一覧表示用の要約 (価格・前日比・スパークライン・テクニカル指標・財務)
  detail/<銘柄>.json チャート用の時系列 (日中足・日足・週足)
  news.json          銘柄ごとのニュース見出し
  state.json         次回実行時に再利用する前回データ (アプリは読まない)

更新頻度:
  価格・日中足・日足 ...... 毎回
  週足(5年) ............... 24時間ごと
  財務指標(PER など) ...... 24時間ごと (1回あたり最大 FUND_PER_RUN 銘柄)
  ニュース ................ 3時間ごと (1回あたり最大 NEWS_PER_RUN 銘柄)
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    from curl_cffi import requests as http
    IMPERSONATE = True
except ImportError:  # ローカル確認用
    import requests as http
    IMPERSONATE = False

ROOT = Path(__file__).resolve().parent.parent
WATCHLIST = ROOT / "data" / "watchlist.json"
UNIVERSE = ROOT / "data" / "universe.json"

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
WEEKLY_REFRESH_SEC = 24 * 3600
FUND_REFRESH_SEC = 24 * 3600
NEWS_REFRESH_SEC = 3 * 3600
FUND_PER_RUN = 30
NEWS_PER_RUN = 45
NEWS_PER_SYMBOL = 6
WORKERS = 4

# Yahoo Finance に無い投資信託の予備データ
#  1) 投資信託協会(投信総合検索ライブラリー)の基準価額CSV (ISIN があれば)
#  2) 運用会社のCSV (FUND_COMPANY_CSV に登録したもの)
#  3) Yahoo!ファイナンス(日本)の銘柄ページ ... 最新の基準価額と前日比のみ
TOUSHIN_CSV = "https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download?isinCd={isin}&associFundCd={code}"
FUND_COMPANY_CSV = {
    "0331418A.T": "https://www.am.mufg.jp/fund_file/setteirai/253425.csv",
}
YAHOO_JP_FUND = "https://finance.yahoo.co.jp/quote/{code}"

MARKET_NEWS_QUERIES = ["日経平均 株式市場", "米国株 ダウ ナスダック"]

DIAG: list[str] = []
_local = threading.local()


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def session():
    s = getattr(_local, "s", None)
    if s is None:
        s = http.Session(impersonate="chrome") if IMPERSONATE else http.Session()
        if not IMPERSONATE:
            s.headers["User-Agent"] = "Mozilla/5.0"
        _local.s = s
    return s


def rnd(x):
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if x != x or x in (float("inf"), float("-inf")):
        return None
    a = abs(x)
    if a >= 1000:
        return round(x, 2)
    if a >= 1:
        return round(x, 4)
    return round(x, 6)


def get_json(url, params=None, tries=3):
    for i in range(tries):
        try:
            r = session().get(url, params=params, timeout=20)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (400, 404):
                return None
            log(f"  HTTP {r.status_code} {url}")
        except Exception as e:  # noqa: BLE001
            log(f"  error {e!r} {url}")
        time.sleep(2 * (i + 1))
    return None


def fetch_chart(symbol, rng, interval):
    url = CHART_URL.format(sym=urllib.parse.quote(symbol, safe=""))
    data = get_json(url, {"range": rng, "interval": interval, "includePrePost": "false"})
    try:
        res = data["chart"]["result"][0]
    except (TypeError, KeyError, IndexError):
        return None, None
    meta = res.get("meta", {})
    ts = res.get("timestamp") or []
    q = (res.get("indicators", {}).get("quote") or [{}])[0]
    closes = q.get("close") or []
    vols = q.get("volume") or []
    t_out, c_out, v_out = [], [], []
    for i, t in enumerate(ts):
        c = closes[i] if i < len(closes) else None
        if c is None:
            continue
        t_out.append(int(t))
        c_out.append(rnd(c))
        v_out.append(int(vols[i]) if i < len(vols) and vols[i] is not None else None)
    return meta, {"t": t_out, "c": c_out, "v": v_out}


# ---------- 投資信託 ----------

def decode_text(raw):
    for enc in ("cp932", "utf-8-sig", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return None


def parse_nav_csv(text):
    """「年月日, 基準価額, ...」形式のCSVを日次系列にする。"""
    t_out, c_out = [], []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 2:
            continue
        m = re.match(r"\s*(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})", row[0])
        if not m:
            continue
        try:
            nav = float(row[1].replace(",", "").replace("円", ""))
        except ValueError:
            continue
        d = datetime(int(m[1]), int(m[2]), int(m[3]), 15, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
        t_out.append(int(d.timestamp()))
        c_out.append(rnd(nav))
    if len(t_out) < 2:
        return None
    pairs = sorted(zip(t_out, c_out))[-260:]
    return {"t": [p[0] for p in pairs], "c": [p[1] for p in pairs], "v": [None] * len(pairs)}


def fetch_csv_series(url, label):
    try:
        r = session().get(url, timeout=25)
        if r.status_code != 200:
            DIAG.append(f"{label}: HTTP {r.status_code}")
            return None
        text = decode_text(r.content)
        series = parse_nav_csv(text) if text else None
        if not series:
            DIAG.append(f"{label}: 読み取り失敗 {(text or '')[:60]!r}")
        return series
    except Exception as e:  # noqa: BLE001
        DIAG.append(f"{label}: {e!r}"[:200])
        return None


def fetch_yahoo_jp_fund(code):
    try:
        r = session().get(YAHOO_JP_FUND.format(code=code), timeout=25)
        if r.status_code != 200:
            DIAG.append(f"yahoo.co.jp {code}: HTTP {r.status_code}")
            return None
        html = r.text
        price = re.search(r'"price":"([\d,]+(?:\.\d+)?)"', html)
        chg = re.search(r'"changePrice":"([+\-]?[\d,]+(?:\.\d+)?)"', html)
        if not price:
            DIAG.append(f"yahoo.co.jp {code}: 価格が見つからない")
            return None
        return float(price[1].replace(",", "")), float(chg[1].replace(",", "")) if chg else 0.0
    except Exception as e:  # noqa: BLE001
        DIAG.append(f"yahoo.co.jp {code}: {e!r}"[:200])
        return None


def fetch_fund(item, prev):
    """戻り値: (日次系列, ソース名)"""
    sym = item["symbol"]
    code = sym.replace(".T", "")
    tries = []
    if item.get("isin"):
        tries.append(("toushin-lib", TOUSHIN_CSV.format(isin=item["isin"], code=code)))
    if sym in FUND_COMPANY_CSV:
        tries.append(("fund-company", FUND_COMPANY_CSV[sym]))
    for label, url in tries:
        s = fetch_csv_series(url, f"{label} {code}")
        if s:
            return s, label
    y = fetch_yahoo_jp_fund(code)
    if y:
        p, c = y
        now = int(time.time())
        pt = list((prev or {}).get("daily", {}).get("t", []))
        pc = list((prev or {}).get("daily", {}).get("c", []))
        if pc and pc[-1] == rnd(p):  # まだ新しい基準価額が出ていない
            pt, pc = pt[:-1], pc[:-1]
        if not pc:
            pt, pc = [now - 86400], [rnd(p - c)]
        return {"t": pt + [now], "c": pc + [rnd(p)], "v": [None] * (len(pt) + 1)}, "yahoo.co.jp"
    return None, None


# ---------- テクニカル指標 (js/indicators.js と同じ計算) ----------

def sma(arr, n):
    return sum(arr[-n:]) / n if len(arr) >= n else None


def sma_series(arr, n):
    out, s = [None] * len(arr), 0.0
    for i, v in enumerate(arr):
        s += v
        if i >= n:
            s -= arr[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def rsi(arr, n=14):
    if len(arr) < n + 1:
        return None
    gain = loss = 0.0
    for i in range(1, n + 1):
        d = arr[i] - arr[i - 1]
        gain += max(d, 0)
        loss += max(-d, 0)
    gain, loss = gain / n, loss / n
    for i in range(n + 1, len(arr)):
        d = arr[i] - arr[i - 1]
        gain = (gain * (n - 1) + max(d, 0)) / n
        loss = (loss * (n - 1) + max(-d, 0)) / n
    if loss == 0:
        return 100.0
    return 100 - 100 / (1 + gain / loss)


def indicators(q, daily):
    c = list(daily["c"])
    if len(c) < 2 or q.get("price") is None:
        return None
    price = q["price"]
    c[-1] = price
    hi = q.get("high52") or max(c)
    lo = q.get("low52") or min(c)
    ma25, ma75, ma200 = sma(c, 25), sma(c, 75), sma(c, 200)

    cross = None
    if len(c) >= 80:
        s25, s75 = sma_series(c, 25), sma_series(c, 75)
        for i in range(len(c) - 5, len(c)):
            a, b = s25[i - 1] - s75[i - 1], s25[i] - s75[i]
            if a <= 0 < b:
                cross = "golden"
            if a >= 0 > b:
                cross = "dead"

    streak = 0
    for i in range(len(c) - 1, 0, -1):
        d = (c[i] > c[i - 1]) - (c[i] < c[i - 1])
        if d == 0:
            break
        if streak == 0:
            streak = d
        elif (streak > 0) == (d > 0):
            streak += d
        else:
            break

    vol_ratio = None
    v = [x for x in (daily.get("v") or []) if x is not None]
    if len(v) > 21:
        avg = sum(v[-21:-1]) / 20
        if avg > 0:
            vol_ratio = v[-1] / avg

    def ret(days):
        return (price / c[-1 - days] - 1) * 100 if len(c) > days and c[-1 - days] else None

    ytd = None
    start = datetime(datetime.now().year, 1, 1, tzinfo=timezone.utc).timestamp()
    idx = next((i for i, t in enumerate(daily["t"]) if t >= start), None)
    if idx and idx > 0:
        ytd = (price / c[idx - 1] - 1) * 100

    return {k: (rnd(v) if isinstance(v, float) else v) for k, v in {
        "rsi": rsi(c), "ma25": ma25, "ma75": ma75, "ma200": ma200, "hi": hi, "lo": lo,
        "pos52": (price - lo) / (hi - lo) * 100 if hi > lo else None,
        "fromHigh": (price / hi - 1) * 100 if hi else None,
        "dev25": (price / ma25 - 1) * 100 if ma25 else None,
        "dev75": (price / ma75 - 1) * 100 if ma75 else None,
        "cross": cross, "streak": streak, "volRatio": vol_ratio,
        "ret1w": ret(5), "ret1m": ret(21), "ret3m": ret(63), "ret6m": ret(126), "ytd": ytd,
    }.items()}


def last_session(series):
    """日中足から直近1日分 (昼休みは含み、夜間の空白で区切る) を取り出す。"""
    t, c = series["t"], series["c"]
    i = len(t) - 1
    while i > 0 and t[i] - t[i - 1] < 3 * 3600 and t[-1] - t[i - 1] < 24 * 3600:
        i -= 1
    return c[i:]


def downsample(arr, n=40):
    if len(arr) <= n:
        return arr
    step = (len(arr) - 1) / (n - 1)
    return [arr[round(i * step)] for i in range(n)]


def local_date(ts, tz):
    return datetime.fromtimestamp(ts, ZoneInfo(tz)).date()


# ---------- 1銘柄の取得 ----------

def build(item, prev):
    """戻り値: (要約, 時系列) / 取得できなければ前回値に stale を付けて返す。"""
    sym = item["symbol"]
    kind = item.get("type") or "stock"
    prev_q, prev_d = (prev or {}).get("q"), (prev or {}).get("d")

    meta, daily = (None, None) if kind == "fund" else fetch_chart(sym, "1y", "1d")
    source = "yahoo"
    if (not daily or not daily["t"]) and kind == "fund":
        daily, source = fetch_fund(item, prev_d)
        meta = {}
    if not daily or not daily["t"]:
        if prev_q:
            log(f"  !! {sym}: 取得失敗 (前回の値を使用)")
            return dict(prev_q, stale=True), prev_d
        log(f"  !! {sym}: 取得できませんでした")
        return {"symbol": sym, "name": item.get("name") or sym, "type": kind, "error": "not_found"}, None

    meta = meta or {}
    tz = meta.get("exchangeTimezoneName") or ("Asia/Tokyo" if sym.endswith(".T") else "America/New_York")
    closes, stamps = daily["c"], daily["t"]
    price = meta.get("regularMarketPrice") or closes[-1]
    mtime = meta.get("regularMarketTime") or stamps[-1]
    if len(closes) >= 2 and local_date(stamps[-1], tz) == local_date(mtime, tz):
        prev_close = closes[-2]
    else:
        prev_close = closes[-1]
    if kind == "fund" and len(closes) >= 2:
        price, prev_close, mtime = closes[-1], closes[-2], stamps[-1]

    intraday = None
    if kind != "fund":
        _, intraday = fetch_chart(sym, "5d", "15m")
        if intraday and not intraday["t"]:
            intraday = None

    q = {
        "symbol": sym,
        "name": item.get("name") or meta.get("shortName") or meta.get("longName") or sym,
        "type": kind,
        "currency": meta.get("currency") or "JPY" if sym.endswith(".T") else meta.get("currency") or "USD",
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
        "price": rnd(price),
        "prevClose": rnd(prev_close),
        "change": rnd(price - prev_close) if prev_close else None,
        "changePct": rnd((price / prev_close - 1) * 100) if prev_close else None,
        "dayHigh": rnd(meta.get("regularMarketDayHigh")),
        "dayLow": rnd(meta.get("regularMarketDayLow")),
        "volume": meta.get("regularMarketVolume"),
        "high52": rnd(meta.get("fiftyTwoWeekHigh")) or rnd(max(closes)),
        "low52": rnd(meta.get("fiftyTwoWeekLow")) or rnd(min(closes)),
        "marketTime": int(mtime),
        "source": source,
    }
    if intraday and len(intraday["c"]) > 3:
        q["spark"] = downsample(last_session(intraday))
        q["sparkBase"] = q["prevClose"]
    else:
        q["spark"] = downsample(closes[-22:])
    q["ind"] = indicators(q, daily)
    q["fundamentals"] = (prev_q or {}).get("fundamentals")

    d = {
        "daily": {"t": daily["t"], "c": daily["c"]},
        "intraday": {"t": intraday["t"], "c": intraday["c"]} if intraday else None,
        "weekly": (prev_d or {}).get("weekly"),
        "weeklyAt": (prev_d or {}).get("weeklyAt", 0),
    }
    if kind != "fund" and time.time() - d["weeklyAt"] >= WEEKLY_REFRESH_SEC:
        _, w = fetch_chart(sym, "5y", "1wk")
        if w and w["t"]:
            d["weekly"], d["weeklyAt"] = {"t": w["t"], "c": w["c"]}, int(time.time())
    q["hasIntraday"] = bool(d["intraday"])
    q["hasWeekly"] = bool(d["weekly"])
    return q, d


# ---------- 財務・ニュース ----------

def fetch_fundamentals(sym):
    try:
        import yfinance as yf
    except ImportError:
        return None
    try:
        t = yf.Ticker(sym, session=session()) if IMPERSONATE else yf.Ticker(sym)
        info = t.info or {}
    except Exception as e:  # noqa: BLE001
        log(f"  fundamentals error {sym} {e!r}")
        return None
    if not info or len(info) < 5:
        return None
    earn = info.get("earningsTimestampStart") or info.get("earningsTimestamp")
    f = {
        "marketCap": info.get("marketCap"),
        "pe": rnd(info.get("trailingPE")),
        "forwardPe": rnd(info.get("forwardPE")),
        "pb": rnd(info.get("priceToBook")),
        "divYield": rnd(info.get("trailingAnnualDividendYield")),
        "beta": rnd(info.get("beta")),
        "targetMean": rnd(info.get("targetMeanPrice")),
        "targetHigh": rnd(info.get("targetHighPrice")),
        "targetLow": rnd(info.get("targetLowPrice")),
        "analysts": info.get("numberOfAnalystOpinions"),
        "recommendation": info.get("recommendationKey"),
        "earningsDate": int(earn) if earn else None,
        "sector": info.get("sector"),
    }
    return {k: v for k, v in f.items() if v is not None} or {}


def fetch_news(query, limit):
    params = {"q": f"{query} when:7d", "hl": "ja", "gl": "JP", "ceid": "JP:ja"}
    try:
        r = session().get("https://news.google.com/rss/search", params=params, timeout=20)
        if r.status_code != 200:
            return None
        root = ET.fromstring(r.content)
    except Exception as e:  # noqa: BLE001
        log(f"  news error {e!r}")
        return None
    out = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        src_el = it.find("source")
        source = src_el.text.strip() if src_el is not None and src_el.text else ""
        if source and title.endswith(" - " + source):
            title = title[: -len(source) - 3]
        pub = it.findtext("pubDate")
        try:
            ts = int(parsedate_to_datetime(pub).timestamp()) if pub else None
        except Exception:  # noqa: BLE001
            ts = None
        out.append({"title": title, "link": it.findtext("link"), "source": source, "t": ts})
        if len(out) >= limit:
            break
    return out


# ---------- 入出力 ----------

def load_prev_state(out_dir):
    """前回の state.json を読む。公開中のサイト → 出力フォルダの順に探す。"""
    url = os.environ.get("PREV_STATE_URL")
    if url:
        try:
            with urllib.request.urlopen(url + f"?t={int(time.time())}", timeout=30) as r:
                log(f"前回データを読み込み: {url}")
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            log(f"前回データなし ({e!r})")
    p = out_dir / "state.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            pass
    return {}


def file_key(sym):
    return re.sub(r"[^A-Za-z0-9.\-]", "_", sym)


def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "_site" / "data"))
    args = ap.parse_args()
    out_dir = Path(args.out)
    (out_dir / "detail").mkdir(parents=True, exist_ok=True)

    cfg = json.loads(WATCHLIST.read_text(encoding="utf-8"))
    universe = json.loads(UNIVERSE.read_text(encoding="utf-8"))

    # 取得対象: マーケット指標 → watchlist の追加銘柄 → 共通一覧
    items, seen = [], set()
    for m in cfg.get("markets", []):
        items.append(dict(m, market=True))
    for s in cfg.get("symbols", []):
        items.append(dict(s))
    for u in universe:
        items.append({"symbol": u["s"], "name": u["n"], "type": u.get("t"), "isin": u.get("isin"), "news": u.get("news")})
    targets = []
    for it in items:
        if it["symbol"] in seen:
            continue
        seen.add(it["symbol"])
        targets.append(it)

    state = load_prev_state(out_dir)
    prev_syms = state.get("symbols", {})
    log(f"{len(targets)} 銘柄を取得します")

    results = {}

    def work(it):
        q, d = build(it, prev_syms.get(it["symbol"]))
        return it["symbol"], q, d

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for sym, q, d in ex.map(work, targets):
            results[sym] = {"q": q, "d": d, "news": (prev_syms.get(sym) or {}).get("news"), "newsAt": (prev_syms.get(sym) or {}).get("newsAt", 0), "fundAt": (prev_syms.get(sym) or {}).get("fundAt", 0)}
    log(f"価格取得: {time.time() - t0:.0f}秒")

    now = time.time()
    # 財務指標: 古い順に最大 FUND_PER_RUN 銘柄
    stocks = [it for it in targets if (it.get("type") or "stock") == "stock" and not results[it["symbol"]]["q"].get("error")]
    due = sorted((it for it in stocks if now - results[it["symbol"]]["fundAt"] >= FUND_REFRESH_SEC), key=lambda it: results[it["symbol"]]["fundAt"])
    for it in due[:FUND_PER_RUN]:
        r = results[it["symbol"]]
        f = fetch_fundamentals(it["symbol"])
        r["fundAt"] = int(now)
        if f is not None:
            r["q"]["fundamentals"] = f
    # ニュース: 株・投信が対象。古い順に最大 NEWS_PER_RUN 銘柄
    newsable = [it for it in targets if not it.get("market") and not results[it["symbol"]]["q"].get("error")]
    due = sorted((it for it in newsable if now - results[it["symbol"]]["newsAt"] >= NEWS_REFRESH_SEC), key=lambda it: results[it["symbol"]]["newsAt"])
    for it in due[:NEWS_PER_RUN]:
        r = results[it["symbol"]]
        n = fetch_news(it.get("news") or f"{r['q']['name']} 株", NEWS_PER_SYMBOL)
        if n is not None:
            r["news"], r["newsAt"] = n, int(now)

    market_news = state.get("marketNews")
    if not market_news or now - state.get("marketNewsAt", 0) >= 3600:
        merged, titles = [], set()
        for qy in MARKET_NEWS_QUERIES:
            for n in fetch_news(qy, 10) or []:
                if n["title"] not in titles:
                    titles.add(n["title"])
                    merged.append(n)
        if merged:
            market_news = sorted(merged, key=lambda n: n.get("t") or 0, reverse=True)[:15]
            state["marketNewsAt"] = int(now)

    ok = sum(1 for r in results.values() if not r["q"].get("error"))
    if ok == 0:
        log("すべての銘柄で取得に失敗したため、出力しません")
        sys.exit(1)

    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for sym, r in results.items():
        if r["d"]:
            dump(out_dir / "detail" / f"{file_key(sym)}.json", {k: v for k, v in r["d"].items() if k != "weeklyAt"})
    dump(out_dir / "quotes.json", {
        "v": 2,
        "generatedAt": generated,
        "markets": [m["symbol"] for m in cfg.get("markets", [])],
        "quotes": {s: r["q"] for s, r in results.items()},
        "marketNews": market_news or [],
    })
    dump(out_dir / "news.json", {"generatedAt": generated, "news": {s: r["news"] for s, r in results.items() if r.get("news")}})
    dump(out_dir / "state.json", {
        "generatedAt": generated,
        "marketNews": market_news or [],
        "marketNewsAt": state.get("marketNewsAt", int(now)),
        "diag": DIAG,
        "symbols": {s: {"q": r["q"], "d": r["d"], "news": r["news"], "newsAt": r["newsAt"], "fundAt": r["fundAt"]} for s, r in results.items()},
    })
    size = (out_dir / "quotes.json").stat().st_size // 1024
    log(f"完了: {ok}/{len(results)} 銘柄 (quotes.json {size} KB, {time.time() - t0:.0f}秒)")
    for d in DIAG:
        log("  diag:", d)


if __name__ == "__main__":
    main()
