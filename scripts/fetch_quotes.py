#!/usr/bin/env python3
"""株価データを取得して data/quotes.json に書き出すスクリプト。

GitHub Actions から定期実行される。data/watchlist.json に書かれた銘柄を
Yahoo Finance から取得し、アプリが読む 1 つの JSON にまとめる。

・価格 / 前日比 / 当日高安 / 52週高安 ........ 毎回
・日中足(5日・15分足) と 日足(1年) ........... 毎回
・週足(5年) / 財務指標(PER・時価総額など) ..... 12時間ごと
・ニュース見出し(Google ニュース RSS) ......... 1時間ごと
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    from curl_cffi import requests as http
    SESSION = http.Session(impersonate="chrome")
except ImportError:  # ローカル確認用
    import requests as http
    SESSION = http.Session()
    SESSION.headers["User-Agent"] = "Mozilla/5.0"

ROOT = Path(__file__).resolve().parent.parent
WATCHLIST = ROOT / "data" / "watchlist.json"
OUTPUT = ROOT / "data" / "quotes.json"

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
SLOW_REFRESH_SEC = 12 * 3600
NEWS_REFRESH_SEC = 3600
NEWS_PER_SYMBOL = 6

# Yahoo で取れない場合の投資信託の予備データ (三菱UFJアセットマネジメントの基準価額CSV)
FUND_FALLBACK_CSV = {
    "0331418A.T": "https://www.am.mufg.jp/fund_file/setteirai/253425.csv",
}

MARKET_NEWS_QUERIES = ["日経平均 株式市場", "米国株 ダウ ナスダック"]


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def rnd(x):
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if x != x:  # NaN
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
            r = SESSION.get(url, params=params, timeout=20)
            if r.status_code == 200:
                return r.json()
            log(f"  HTTP {r.status_code} {url}")
            if r.status_code in (404, 400):
                return r.json() if r.headers.get("content-type", "").startswith("application/json") else None
        except Exception as e:  # noqa: BLE001
            log(f"  error {e!r} {url}")
        time.sleep(1.5 * (i + 1))
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


def fetch_fund_fallback(symbol):
    """投信会社のCSVから日次の基準価額を読む (Yahoo で取れないとき用)。"""
    url = FUND_FALLBACK_CSV.get(symbol)
    if not url:
        return None
    try:
        r = SESSION.get(url, timeout=20)
        if r.status_code != 200:
            return None
        raw = r.content
        text = None
        for enc in ("cp932", "utf-8-sig", "utf-8"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        if text is None:
            return None
        t_out, c_out = [], []
        for row in csv.reader(io.StringIO(text)):
            if len(row) < 2:
                continue
            m = re.match(r"\s*(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})", row[0])
            if not m:
                continue
            try:
                nav = float(row[1].replace(",", ""))
            except ValueError:
                continue
            d = datetime(int(m[1]), int(m[2]), int(m[3]), 15, 0, tzinfo=ZoneInfo("Asia/Tokyo"))
            t_out.append(int(d.timestamp()))
            c_out.append(rnd(nav))
        if not t_out:
            return None
        pairs = sorted(zip(t_out, c_out))[-260:]
        return {"t": [p[0] for p in pairs], "c": [p[1] for p in pairs], "v": [None] * len(pairs)}
    except Exception as e:  # noqa: BLE001
        log(f"  fund fallback error {e!r}")
        return None


def local_date(ts, tz):
    return datetime.fromtimestamp(ts, ZoneInfo(tz)).date()


def build_quote(item, prev):
    sym = item["symbol"]
    log(f"- {sym}")
    kind = item.get("type", "stock")
    now = time.time()

    meta, daily = fetch_chart(sym, "1y", "1d")
    source = "yahoo"
    if (not daily or not daily["t"]) and kind == "fund":
        daily = fetch_fund_fallback(sym)
        meta = {}
        source = "fund-csv"
    if not daily or not daily["t"]:
        log(f"  !! {sym}: 取得できませんでした")
        if prev:
            prev = dict(prev)
            prev["stale"] = True
            return prev
        return {"symbol": sym, "name": item.get("name") or sym, "error": "not_found", "list": item.get("list")}

    tz = meta.get("exchangeTimezoneName") or ("Asia/Tokyo" if sym.endswith(".T") else "America/New_York")
    price = meta.get("regularMarketPrice") or daily["c"][-1]
    mtime = meta.get("regularMarketTime") or daily["t"][-1]

    # 前日終値: 日足の最後の足が当日分ならその1本前
    closes, stamps = daily["c"], daily["t"]
    if len(closes) >= 2 and local_date(stamps[-1], tz) == local_date(mtime, tz):
        prev_close = closes[-2]
    else:
        prev_close = closes[-1]
    if kind == "fund" and len(closes) >= 2:
        price, prev_close, mtime = closes[-1], closes[-2], stamps[-1]

    intraday = None
    if kind != "fund":
        _, intraday = fetch_chart(sym, "5d", "15m")

    q = {
        "symbol": sym,
        "name": item.get("name") or meta.get("shortName") or meta.get("longName") or sym,
        "longName": meta.get("longName") or meta.get("shortName"),
        "type": kind,
        "list": item.get("list"),
        "currency": meta.get("currency") or ("JPY" if sym.endswith(".T") else "USD"),
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
        "tz": tz,
        "price": rnd(price),
        "prevClose": rnd(prev_close),
        "change": rnd(price - prev_close) if price is not None and prev_close else None,
        "changePct": rnd((price / prev_close - 1) * 100) if price is not None and prev_close else None,
        "dayHigh": rnd(meta.get("regularMarketDayHigh")),
        "dayLow": rnd(meta.get("regularMarketDayLow")),
        "volume": meta.get("regularMarketVolume"),
        "high52": rnd(meta.get("fiftyTwoWeekHigh")) or rnd(max(closes)),
        "low52": rnd(meta.get("fiftyTwoWeekLow")) or rnd(min(closes)),
        "marketTime": int(mtime),
        "source": source,
        "daily": {"t": daily["t"], "c": daily["c"]},
        "dailyVol": daily["v"],
        "intraday": {"t": intraday["t"], "c": intraday["c"]} if intraday and intraday["t"] else None,
    }

    # 週足5年・財務情報は負荷を減らすため12時間ごと
    prev_slow = (prev or {}).get("slowAt", 0)
    if prev and now - prev_slow < SLOW_REFRESH_SEC and prev.get("weekly") is not None:
        q["weekly"] = prev.get("weekly")
        q["fundamentals"] = prev.get("fundamentals")
        q["slowAt"] = prev_slow
    else:
        weekly = None
        if kind != "fund":
            _, w = fetch_chart(sym, "5y", "1wk")
            weekly = {"t": w["t"], "c": w["c"]} if w and w["t"] else None
        q["weekly"] = weekly
        q["fundamentals"] = fetch_fundamentals(sym) if kind == "stock" else None
        if q["fundamentals"] is None and prev:
            q["fundamentals"] = prev.get("fundamentals")
        q["slowAt"] = int(now)

    # ニュース(保有・ウォッチ銘柄のみ)
    if item.get("list"):
        prev_news_at = (prev or {}).get("newsAt", 0)
        if prev and now - prev_news_at < NEWS_REFRESH_SEC and prev.get("news") is not None:
            q["news"], q["newsAt"] = prev["news"], prev_news_at
        else:
            query = item.get("news") or f"{q['name']} 株価"
            news = fetch_news(query, NEWS_PER_SYMBOL)
            q["news"] = news if news is not None else (prev or {}).get("news", [])
            q["newsAt"] = int(now)
    return q


def fetch_fundamentals(sym):
    try:
        import yfinance as yf
    except ImportError:
        return None
    try:
        t = yf.Ticker(sym, session=SESSION) if hasattr(SESSION, "impersonate") else yf.Ticker(sym)
        info = t.info or {}
    except Exception as e:  # noqa: BLE001
        log(f"  fundamentals error {e!r}")
        return None
    if not info:
        return None
    earn = info.get("earningsTimestampStart") or info.get("earningsTimestamp")
    f = {
        "marketCap": info.get("marketCap"),
        "pe": rnd(info.get("trailingPE")),
        "forwardPe": rnd(info.get("forwardPE")),
        "pb": rnd(info.get("priceToBook")),
        "eps": rnd(info.get("trailingEps") or info.get("epsTrailingTwelveMonths")),
        "divYield": rnd(info.get("trailingAnnualDividendYield")),
        "beta": rnd(info.get("beta")),
        "targetMean": rnd(info.get("targetMeanPrice")),
        "targetHigh": rnd(info.get("targetHighPrice")),
        "targetLow": rnd(info.get("targetLowPrice")),
        "analysts": info.get("numberOfAnalystOpinions"),
        "recommendation": info.get("recommendationKey"),
        "earningsDate": int(earn) if earn else None,
        "sector": info.get("sector"),
        "industry": info.get("industry"),
    }
    return {k: v for k, v in f.items() if v is not None} or None


def fetch_news(query, limit):
    url = "https://news.google.com/rss/search"
    params = {"q": f"{query} when:7d", "hl": "ja", "gl": "JP", "ceid": "JP:ja"}
    try:
        r = SESSION.get(url, params=params, timeout=20)
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


def main():
    cfg = json.loads(WATCHLIST.read_text(encoding="utf-8"))
    prev_all = {}
    prev_doc = {}
    if OUTPUT.exists():
        try:
            prev_doc = json.loads(OUTPUT.read_text(encoding="utf-8"))
            prev_all = prev_doc.get("quotes", {})
        except Exception:  # noqa: BLE001
            pass

    items = [dict(m, list=None) for m in cfg.get("markets", [])] + list(cfg.get("symbols", []))
    quotes, seen = {}, set()
    for item in items:
        sym = item["symbol"]
        if sym in seen:
            continue
        seen.add(sym)
        quotes[sym] = build_quote(item, prev_all.get(sym))
        time.sleep(0.25)

    now = time.time()
    market_news = prev_doc.get("marketNews")
    if not market_news or now - prev_doc.get("marketNewsAt", 0) >= NEWS_REFRESH_SEC:
        merged, titles = [], set()
        for qy in MARKET_NEWS_QUERIES:
            for n in fetch_news(qy, 10) or []:
                if n["title"] not in titles:
                    titles.add(n["title"])
                    merged.append(n)
        merged.sort(key=lambda n: n.get("t") or 0, reverse=True)
        if merged:
            market_news = merged[:15]
            prev_doc["marketNewsAt"] = int(now)

    ok = sum(1 for q in quotes.values() if not q.get("error"))
    doc = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "markets": [m["symbol"] for m in cfg.get("markets", [])],
        "quotes": quotes,
        "marketNews": market_news or [],
        "marketNewsAt": prev_doc.get("marketNewsAt", int(now)),
    }
    if ok == 0:
        log("すべての銘柄で取得に失敗したため、ファイルは更新しません")
        sys.exit(1)
    OUTPUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"done: {ok}/{len(quotes)} 銘柄 -> {OUTPUT} ({OUTPUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
