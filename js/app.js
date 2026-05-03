  /* =====================================================================
 * app.js - ニュース読んでる？ 共通ロジック（Google OAuth 版）
 *
 * 認証は Supabase の Google OAuth を使用。ログイン状態は localStorage
 * (newsquiz_user_id, newsquiz_guest_name) で管理する。
 *
 * Supabase 側のテーブル想定:
 *   users    : id (uuid, auth.users.id と同じ) / guest_name (text)
 *              total_score (int) / total_attempts (int) / rank_level (int)
 *   quizzes  : id / week_key (text) / category (text 'politics'|'economy')
 *              question / option_a..option_d / correct_option ('A'..'D')
 *   answers  : id / user_id / quiz_id / attempt_id / week_key / category
 *              selected_option / is_correct / created_at
 * ===================================================================== */

const NewsQuiz = (() => {

 // ===== 設定（GitHub Pages にデプロイする前に書き換えてください）=====
  const SUPABASE_URL      = 'https://alpshubuznjyyxuvnzhx.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFscHNodWJ1em5qeXl4dXZuemh4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Nzc5MTQ5MSwiZXhwIjoyMDkzMzY3NDkxfQ.cJ_thMU1tS3LCTIiIBOHHDHaxtYVt1WR6byPF7dNo3A';

  // localStorage キー
  const LS_USER_ID    = 'newsquiz_user_id';
  const LS_GUEST_NAME = 'newsquiz_guest_name';

  // ===== ランク（rank_level: 0〜15）=====
  const RANK_NAMES = [
    '学生',                     //  0
    '財務省入省',                //  1
    '省庁研修・事務官',          //  2
    '係員・主査',                //  3
    '課長補佐',                  //  4
    '主計局総務課長',            //  5
    '審議官・主計局長',          //  6
    '財務省事務次官',            //  7
    '衆議院議員',                //  8
    '衆院財務金融委員会委員長',  //  9
    '財務大臣',                  // 10
    '内閣官房長官',              // 11
    '未来党政務調査会長',        // 12
    '未来党幹事長',              // 13
    '未来党総裁',                // 14
    '内閣総理大臣',              // 15
  ];

  // 昇格しきい値: total_score × total_attempts >= RANK_THRESHOLDS[level] でその level に到達
  const RANK_THRESHOLDS = [
    0, 10, 50, 150, 400, 800, 1500, 2500,
    4000, 6000, 8500, 12000, 17000, 24000, 35000, 50000,
  ];

  function rankClassFor(level) {
    if (level <= 1)  return 'rank-student';
    if (level <= 3)  return 'rank-official';
    if (level <= 7)  return 'rank-bureau';
    if (level <= 12) return 'rank-diet';
    return 'rank-pm';
  }

  // ===== Supabase クライアント（一度だけ作る）=====
  let _client = null;
  function getClient() {
    if (!_client) {
      _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,   // OAuth コールバックを自動検出
        },
      });
    }
    return _client;
  }

  // ===== Google OAuth =====
  async function signInWithGoogle() {
    const sb = getClient();
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: {
        // ログイン後にこのページに戻ってくる
        redirectTo: window.location.origin + window.location.pathname,
      },
    });
    if (error) throw error;
    // ここで Google にリダイレクトされる
  }

  // OAuth コールバック後に Supabase が認識しているユーザーを返す
  async function getAuthUser() {
    const { data: { user } } = await getClient().auth.getUser();
    return user;
  }

  // users テーブルにプロフィールが存在するか調べる（無ければ null）
  async function findProfile(uid) {
    const { data, error } = await getClient()
      .from('users')
      .select('id, guest_name, total_score, total_attempts, rank_level')
      .eq('id', uid)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  // 初回ログイン時に users テーブルにプロフィールを作成
  async function createProfile(uid, guestName) {
    const name = (guestName || '').trim();
    if (!name) throw new Error('ゲスト名を入力してください');

    const { error } = await getClient()
      .from('users')
      .insert({
        id:             uid,
        guest_name:     name,
        rank_level:     0,
        total_score:    0,
        total_attempts: 0,
      });
    if (error) throw error;
  }

  // ===== localStorage 管理 =====
  function setLocalAuth(uid, guestName) {
    localStorage.setItem(LS_USER_ID,    uid);
    localStorage.setItem(LS_GUEST_NAME, guestName);
  }

  function clearLocalAuth() {
    localStorage.removeItem(LS_USER_ID);
    localStorage.removeItem(LS_GUEST_NAME);
  }

  function getLocalAuth() {
    const uid  = localStorage.getItem(LS_USER_ID);
    const name = localStorage.getItem(LS_GUEST_NAME);
    if (!uid) return null;
    return { id: uid, guest_name: name };
  }

  // 全ページ共通：未ログインなら index.html へリダイレクト
  // 戻り値は { id, guest_name } か null
  async function requireLogin() {
    const local = getLocalAuth();
    if (!local) {
      location.replace('index.html');
      return null;
    }
    return local;
  }

  // ===== ログアウト =====
  async function signOut() {
    try { await getClient().auth.signOut(); } catch (_) {}
    clearLocalAuth();
  }

  // ===== プロフィール（最新値を取りに行く）=====
  async function getProfile(userId) {
    const { data, error } = await getClient()
      .from('users')
      .select('id, guest_name, total_score, total_attempts, rank_level')
      .eq('id', userId)
      .single();
    if (error) throw error;
    return data;
  }

  // ===== クイズ取得 =====
  async function getLatestQuizzes() {
    const sb = getClient();

    const { data: latest, error: e1 } = await sb
      .from('quizzes')
      .select('week_key')
      .order('week_key', { ascending: false })
      .limit(1);
    if (e1) throw e1;
    if (!latest || latest.length === 0) return [];

    const weekKey = latest[0].week_key;

    const { data, error } = await sb
      .from('quizzes')
      .select('id, week_key, category, question, option_a, option_b, option_c, option_d, correct_option')
      .eq('week_key', weekKey)
      .order('id', { ascending: true });
    if (error) throw error;
    return data;
  }

  async function getAllWeeks() {
    const { data, error } = await getClient()
      .from('quizzes')
      .select('week_key')
      .order('week_key', { ascending: false });
    if (error) throw error;
    return [...new Set((data || []).map(q => q.week_key))];
  }

  async function getQuizCount(weekKey) {
    const { count, error } = await getClient()
      .from('quizzes')
      .select('id', { count: 'exact', head: true })
      .eq('week_key', weekKey);
    if (error) throw error;
    return count || 0;
  }

  // ===== 回答送信 =====
  async function submitAnswers(userId, quizzes, answers) {
    const sb = getClient();

    const attemptId = (window.crypto?.randomUUID?.()) ||
      `att_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const rows = quizzes.map((q, i) => ({
      user_id:         userId,
      quiz_id:         q.id,
      attempt_id:      attemptId,
      week_key:        q.week_key,
      category:        q.category,
      selected_option: answers[i],
      is_correct:      answers[i] === q.correct_option,
    }));

    const { error: insErr } = await sb.from('answers').insert(rows);
    if (insErr) throw insErr;

    const score = rows.filter(r => r.is_correct).length;

    const profile     = await getProfile(userId);
    const newScore    = profile.total_score    + score;
    const newAttempts = profile.total_attempts + 1;
    const newRank     = calculateRank(newScore, newAttempts);

    const { error: upErr } = await sb
      .from('users')
      .update({
        total_score:    newScore,
        total_attempts: newAttempts,
        rank_level:     newRank,
      })
      .eq('id', userId);
    if (upErr) throw upErr;

    return { score, total: quizzes.length, newRank };
  }

  function calculateRank(totalScore, totalAttempts) {
    const product = totalScore * totalAttempts;
    let level = 0;
    for (let i = 0; i < RANK_THRESHOLDS.length; i++) {
      if (product >= RANK_THRESHOLDS[i]) level = i;
      else break;
    }
    return Math.min(level, RANK_NAMES.length - 1);
  }

  // ===== 自分の成績 =====
  async function getMyStats(userId) {
    const sb = getClient();

    const { data: rows, error } = await sb
      .from('answers')
      .select('attempt_id, week_key, category, is_correct, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const groups = new Map();
    for (const r of rows || []) {
      if (!groups.has(r.attempt_id)) {
        groups.set(r.attempt_id, {
          attempt_id: r.attempt_id,
          week_key:   r.week_key,
          score:      0,
          total:      0,
          politics_correct: 0, politics_total: 0,
          economy_correct:  0, economy_total:  0,
          created_at: r.created_at,
        });
      }
      const g = groups.get(r.attempt_id);
      g.total++;
      if (r.is_correct) g.score++;
      if (r.category === 'politics') {
        g.politics_total++; if (r.is_correct) g.politics_correct++;
      } else {
        g.economy_total++;  if (r.is_correct) g.economy_correct++;
      }
    }

    const history = [...groups.values()].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );

    const { data: latest } = await sb
      .from('quizzes')
      .select('week_key')
      .order('week_key', { ascending: false })
      .limit(1);
    const currentWeek = latest?.[0]?.week_key || null;
    const thisWeek = currentWeek ? history.find(h => h.week_key === currentWeek) : null;

    return {
      thisWeekScore: thisWeek ? thisWeek.score : null,
      thisWeekTotal: thisWeek ? thisWeek.total : null,
      currentWeek,
      history,
    };
  }

  // ===== 他人の成績 =====
  async function getOthersStats(weekKey) {
    const sb = getClient();

    const { data: rows, error } = await sb
      .from('answers')
      .select('user_id, attempt_id, is_correct')
      .eq('week_key', weekKey);
    if (error) throw error;
    if (!rows || rows.length === 0) return [];

    const scoreMap = new Map();
    for (const r of rows) {
      const k = `${r.user_id}|${r.attempt_id}`;
      scoreMap.set(k, (scoreMap.get(k) || 0) + (r.is_correct ? 1 : 0));
    }

    const bestByUser = new Map();
    for (const [k, score] of scoreMap.entries()) {
      const [userId] = k.split('|');
      if (!bestByUser.has(userId) || bestByUser.get(userId) < score) {
        bestByUser.set(userId, score);
      }
    }

    const userIds = [...bestByUser.keys()];
    const { data: users, error: e2 } = await sb
      .from('users')
      .select('id, guest_name, rank_level')
      .in('id', userIds);
    if (e2) throw e2;
    const userMap = new Map((users || []).map(u => [u.id, u]));

    return [...bestByUser.entries()]
      .map(([userId, score]) => {
        const u = userMap.get(userId);
        return {
          user_id:    userId,
          guest_name: u?.guest_name ?? '(不明)',
          rank_level: u?.rank_level ?? 0,
          score,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  // ===== ランキング =====
  async function getRanking() {
    const { data, error } = await getClient()
      .from('users')
      .select('id, guest_name, total_score, total_attempts, rank_level');
    if (error) throw error;
    return [...(data || [])].sort(
      (a, b) => (b.total_score * b.total_attempts) - (a.total_score * a.total_attempts)
    );
  }

  // ===== UI ヘルパー =====
  function applyRankClass(body, rankLevel) {
    body.classList.remove('rank-student', 'rank-official', 'rank-bureau', 'rank-diet', 'rank-pm');
    body.classList.add(rankClassFor(rankLevel));
  }

  function categoryLabel(cat) {
    if (cat === 'politics') return '政治';
    if (cat === 'economy')  return '経済';
    return cat;
  }

  function categoryClass(cat) {
    return cat === 'politics' ? 'cyan' : 'yellow';
  }

  function showMsg(elementId, text, isError) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', !!isError);
  }

  // ===== 公開 =====
  return {
    SUPABASE_URL,
    RANK_NAMES, RANK_THRESHOLDS,
    // 認証
    signInWithGoogle, getAuthUser, findProfile, createProfile,
    setLocalAuth, clearLocalAuth, getLocalAuth,
    requireLogin, signOut,
    // データ
    getProfile,
    getLatestQuizzes, getAllWeeks, getQuizCount,
    submitAnswers, calculateRank,
    getMyStats, getOthersStats, getRanking,
    // UI
    applyRankClass, categoryLabel, categoryClass, showMsg,
  };
})();
