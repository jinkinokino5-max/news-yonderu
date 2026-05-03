"""
generate_quiz.py
================
週次ニュースクイズ自動生成スクリプト。

毎週日曜 23:59 JST に GitHub Actions から実行され、Currents News API から
直近 1 週間の政治・経済ニュースを取得し、4 択クイズ 10 問を自動生成して
Supabase の `quizzes` テーブルに保存します。

外部 LLM は使わず、ニュースの「タイトル」と「説明文」だけを使ってクイズを
組み立てるシンプルな方式です。

必要な環境変数:
    CURRENTS_API_KEY            : Currents News API のキー
    SUPABASE_URL                : Supabase プロジェクトの URL
    SUPABASE_SERVICE_ROLE_KEY   : Supabase の service_role キー
"""

from __future__ import annotations

import os
import re
import sys
import random
from datetime import datetime, timedelta, timezone

import requests
from supabase import create_client, Client


# ---------------------------------------------------------------------------
# 設定（必要に応じて書き換えてください）
# ---------------------------------------------------------------------------
CURRENTS_API_KEY          = os.environ.get("CURRENTS_API_KEY", "")
SUPABASE_URL              = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

CURRENTS_ENDPOINT = "https://api.currentsapi.services/v1/search"

# 生成する問題数
TOTAL_QUESTIONS    = 10
POLITICS_QUESTIONS = 5
ECONOMY_QUESTIONS  = 5

# 経済寄りの記事を補強するためのキーワード
ECONOMY_KEYWORDS = ["economy", "financial", "budget", "tax", "GDP"]

# JST タイムゾーン
JST = timezone(timedelta(hours=9))


# ---------------------------------------------------------------------------
# ログ
# ---------------------------------------------------------------------------
def log(msg: str) -> None:
    """進捗をコンソールに出力する。"""
    print(f"[generate_quiz] {msg}", flush=True)


# ---------------------------------------------------------------------------
# 週キー（YYYY-MM-DD 形式の「日曜日」）
# ---------------------------------------------------------------------------
def get_week_key(now: datetime | None = None) -> str:
    """
    実行日を含む週の「日曜日」を返す。
    日曜の 23:59 に走るのが想定なので、ふつうは当日の日付が返る。
    """
    now = now or datetime.now(JST)
    # Python の weekday: Monday=0 ... Sunday=6
    days_to_sunday = (6 - now.weekday()) % 7
    sunday = (now + timedelta(days=days_to_sunday)).date()
    return sunday.strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# ニュース取得
# ---------------------------------------------------------------------------
def fetch_news(category: str, language: str, keywords: str = "") -> list[dict]:
    """Currents News API から記事を取得する（直近 7 日間）。"""
    end_date   = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=7)

    params = {
        "apiKey":     CURRENTS_API_KEY,
        "category":   category,
        "language":   language,
        "start_date": start_date.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "end_date":   end_date.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    }
    if keywords:
        params["keywords"] = keywords

    label = f"category={category}, lang={language}" + (f", keywords={keywords}" if keywords else "")
    log(f"ニュース取得中: {label}")

    try:
        res = requests.get(CURRENTS_ENDPOINT, params=params, timeout=30)
        res.raise_for_status()
        news = res.json().get("news") or []
        log(f"  → {len(news)} 件取得")
        return news
    except requests.RequestException as e:
        log(f"  ! 取得失敗: {e}")
        return []


def dedupe_by_title(items: list[dict]) -> list[dict]:
    """タイトル重複を取り除く。"""
    seen, out = set(), []
    for it in items:
        title = (it.get("title") or "").strip()
        if title and title not in seen:
            seen.add(title)
            out.append(it)
    return out


def collect_all_news() -> tuple[list[dict], list[dict]]:
    """政治・経済のニュースを英語と日本語で取得し、重複を除いて返す。"""
    politics: list[dict] = []
    economy:  list[dict] = []

    for lang in ("en", "ja"):
        politics += fetch_news("politics", lang)

    for lang in ("en", "ja"):
        economy += fetch_news("business", lang)
        economy += fetch_news("business", lang, keywords=",".join(ECONOMY_KEYWORDS))

    politics = dedupe_by_title(politics)
    economy  = dedupe_by_title(economy)
    log(f"重複除去後: 政治 {len(politics)} 件 / 経済 {len(economy)} 件")
    return politics, economy


# ---------------------------------------------------------------------------
# クイズ生成
# ---------------------------------------------------------------------------
SENTENCE_SPLIT = re.compile(r"[。．\.!\?！？]\s*")


def extract_key_sentence(text: str) -> str:
    """記事の本文から、選択肢として使える 1 文を抜き出す。"""
    if not text:
        return ""
    sentences = [s.strip() for s in SENTENCE_SPLIT.split(text) if s.strip()]
    # 10〜80 文字くらいの「ちょうどいい長さ」の最初の文を選ぶ
    for s in sentences:
        if 10 <= len(s) <= 80:
            return s
    # 適切な文がなければ先頭を返す
    if sentences:
        return sentences[0][:80]
    return text[:80]


def shorten(s: str, n: int = 70) -> str:
    """選択肢の長さを揃える（長すぎるものは末尾を省略）。"""
    s = re.sub(r"\s+", " ", (s or "").strip())
    return s if len(s) <= n else s[: n - 1] + "…"


def build_question(article: dict, distractor_pool: list[dict], category: str) -> dict | None:
    """1 つの記事から 1 問の 4 択クイズを作る。"""
    title       = (article.get("title") or "").strip()
    description = (article.get("description") or "").strip()
    body        = description or title
    if not title or not body:
        return None

    # 正解：本文から抜粋
    correct = shorten(extract_key_sentence(body))
    if not correct:
        return None

    # ダミー：同カテゴリの「別の記事」から拾う
    pool = [a for a in distractor_pool if a is not article]
    random.shuffle(pool)

    distractors: list[str] = []
    for a in pool:
        candidate = shorten(extract_key_sentence(a.get("description") or a.get("title") or ""))
        if candidate and candidate != correct and candidate not in distractors:
            distractors.append(candidate)
        if len(distractors) == 3:
            break

    if len(distractors) < 3:
        return None  # ダミーが足りない記事はスキップ

    # 4 つの選択肢をシャッフル
    options = [correct, *distractors]
    random.shuffle(options)
    correct_letter = ["A", "B", "C", "D"][options.index(correct)]

    question_text = (
        "次の見出しのニュースに最も関係する内容はどれか？\n"
        f"「{shorten(title, 80)}」"
    )

    return {
        "question":       question_text,
        "option_a":       options[0],
        "option_b":       options[1],
        "option_c":       options[2],
        "option_d":       options[3],
        "correct_option": correct_letter,
        "category":       category,
    }


def generate_quizzes(politics_news: list[dict], economy_news: list[dict]) -> list[dict]:
    """政治 5 問・経済 5 問の合計 10 問を生成する。"""
    quizzes: list[dict] = []

    for art in politics_news:
        q = build_question(art, politics_news, category="politics")
        if q:
            quizzes.append(q)
        if sum(1 for x in quizzes if x["category"] == "politics") >= POLITICS_QUESTIONS:
            break

    for art in economy_news:
        q = build_question(art, economy_news, category="economy")
        if q:
            quizzes.append(q)
        if sum(1 for x in quizzes if x["category"] == "economy") >= ECONOMY_QUESTIONS:
            break

    pol_n = sum(1 for q in quizzes if q["category"] == "politics")
    eco_n = sum(1 for q in quizzes if q["category"] == "economy")
    log(f"クイズ生成完了: {len(quizzes)} 問（政治 {pol_n} / 経済 {eco_n}）")
    return quizzes[:TOTAL_QUESTIONS]


# ---------------------------------------------------------------------------
# Supabase 保存
# ---------------------------------------------------------------------------
def save_to_supabase(quizzes: list[dict], week_key: str) -> None:
    """Supabase に保存する。同じ week_key が既にあればスキップ。"""
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。")

    supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    # 既存チェック
    existing = (
        supabase.table("quizzes")
        .select("id")
        .eq("week_key", week_key)
        .limit(1)
        .execute()
    )
    if existing.data:
        log(f"week_key={week_key} は既に登録済みのためスキップします。")
        return

    rows = [{**q, "week_key": week_key} for q in quizzes]
    res = supabase.table("quizzes").insert(rows).execute()
    inserted = len(res.data) if res.data else 0
    log(f"Supabase に {inserted} 行 INSERT しました（week_key={week_key}）")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> int:
    if not CURRENTS_API_KEY:
        log("ERROR: 環境変数 CURRENTS_API_KEY が未設定です。")
        return 1

    week_key = get_week_key()
    log(f"今週の week_key = {week_key}")

    politics_news, economy_news = collect_all_news()
    if not politics_news and not economy_news:
        log("ERROR: ニュースを 1 件も取得できませんでした。終了します。")
        return 1

    quizzes = generate_quizzes(politics_news, economy_news)
    if not quizzes:
        log("ERROR: クイズを生成できませんでした。終了します。")
        return 1
    if len(quizzes) < TOTAL_QUESTIONS:
        log(f"WARN: 10 問に届きませんでした（{len(quizzes)} 問）。可能な分だけ保存します。")

    save_to_supabase(quizzes, week_key)
    log("完了 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
