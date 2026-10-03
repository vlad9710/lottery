// Хранилище статистики моментальной лотереи в Google Таблице.
// Калькулятор шлёт сюда POST с JSON вида {action, ...}: "start", "game" или "stats".
// Установка: Расширения → Apps Script → вставить этот файл → Начать развёртывание →
// Веб-приложение, «Запуск от имени: я», «Доступ: все».
// Листы «games» и «starts» создаются сами. Можно заранее импортировать на них выгрузку
// из Supabase: столбцы ищутся по заголовкам, лишние не мешают.

const GAMES = "games";
const STARTS = "starts";
const GAME_COLS = ["created_at", "game_id", "player", "grid", "line", "best_line", "line_sum", "score",
  "expected", "best_expected", "p_jack", "p_big", "p_mid", "elf_possible", "elf_shown", "elf_moments",
  "elf_kind", "elf_done"];
const START_COLS = ["created_at", "game_id", "player"];

const LINES = [[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6],[6,7,8],[3,4,5],[0,1,2]];
const PAY = {6:1680,7:84,8:630,9:280,10:42,11:34,12:180,13:120,14:53,15:105,16:53,17:144,18:48,19:202,20:105,21:51,22:420,23:840,24:1008};

const GAME_GAP = 15;     // не чаще одной партии в 15 секунд с одного устройства
const START_GAP = 10;    // и одной отметки о выборе линии в 10 секунд
const STATS_TTL = 60;    // готовую сводку пересчитываем не чаще раза в минуту

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return reply({ error: "bad_request" }); }
  try {
    if (body.action === "start") return reply(addStart(body.row || {}));
    if (body.action === "game") return reply(addGame(body.row || {}));
    if (body.action === "stats") return reply(getStats(String(body.player || "")));
    return reply({ error: "bad_request" });
  } catch (err) {
    return reply({ error: "server: " + err });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Лист с нужными столбцами: создаём, если его нет, и дописываем недостающие заголовки
function sheet(name, cols) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.appendRow(cols);
    sh.setFrozenRows(1);
    return sh;
  }
  const header = headerOf(sh);
  const missing = cols.filter(c => header.indexOf(c) < 0);
  if (missing.length) sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
  return sh;
}

function headerOf(sh) {
  const n = sh.getLastColumn();
  return n ? sh.getRange(1, 1, 1, n).getValues()[0].map(String) : [];
}

// Строка в порядке столбцов листа
function appendByHeader(sh, obj) {
  sh.appendRow(headerOf(sh).map(c => (c in obj ? obj[c] : "")));
}

// ---------- Первый этап: партия дошла до выбора линии ----------
function addStart(row) {
  const player = String(row.player || "");
  const gameId = String(row.game_id || "");
  if (player.length < 1 || player.length > 20 || !/^[0-9a-f-]{36}$/i.test(gameId)) return { error: "bad_game: start" };
  const cache = CacheService.getScriptCache();
  if (cache.get("sid:" + gameId)) return { ok: true, duplicate: true };
  if (cache.get("s:" + player)) return { error: "rate_limit" };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    appendByHeader(sheet(STARTS, START_COLS), { created_at: new Date(), game_id: gameId, player });
    cache.put("sid:" + gameId, "1", 21600);
    cache.put("s:" + player, "1", START_GAP);
  } finally { lock.releaseLock(); }
  return { ok: true };
}

// ---------- Второй этап: результат партии ----------
function addGame(r) {
  const bad = checkGame(r);
  if (bad) return { error: "bad_game: " + bad };
  const cache = CacheService.getScriptCache();
  if (r.game_id && cache.get("gid:" + r.game_id)) return { ok: true, duplicate: true };
  if (cache.get("g:" + r.player)) return { error: "rate_limit" };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    appendByHeader(sheet(GAMES, GAME_COLS), {
      created_at: new Date(), game_id: r.game_id || "", player: r.player, grid: "'" + r.grid,
      line: r.line, best_line: r.best_line, line_sum: r.line_sum, score: r.score,
      expected: r.expected, best_expected: r.best_expected,
      p_jack: r.p_jack || 0, p_big: r.p_big, p_mid: r.p_mid,
      elf_possible: !!r.elf_possible, elf_shown: !!r.elf_shown, elf_moments: r.elf_moments || 0,
      elf_kind: r.elf_kind || "", elf_done: r.elf_done || ""
    });
    if (r.game_id) cache.put("gid:" + r.game_id, "1", 21600);
    cache.put("g:" + r.player, "1", GAME_GAP);
    cache.remove("stats");
    cache.remove("me:" + r.player);
  } finally { lock.releaseLock(); }
  return { ok: true };
}

// Те же проверки, что были в базе Supabase: поле, сумма, очки, диапазоны
function checkGame(r) {
  const num = (v, lo, hi) => typeof v === "number" && isFinite(v) && v >= lo && v <= hi;
  const int = (v, lo, hi) => num(v, lo, hi) && Math.floor(v) === v;
  if (typeof r.player !== "string" || r.player.length < 1 || r.player.length > 20) return "player";
  if (r.game_id && !/^[0-9a-f-]{36}$/i.test(String(r.game_id))) return "game_id";
  if (typeof r.grid !== "string" || !/^[0-9]{9}$/.test(r.grid)) return "grid";
  if (!int(r.line, 0, 7) || !int(r.best_line, 0, 7) || !int(r.line_sum, 6, 24)) return "line";
  if (!int(r.score, 0, 10000) || !int(r.expected, 0, 10000) || !int(r.best_expected, 0, 10000)) return "numbers";
  if (!num(r.p_jack || 0, 0, 1) || !num(r.p_big, 0, 1) || !num(r.p_mid, 0, 1)) return "chances";
  if (r.elf_shown && !r.elf_possible) return "elf";
  if (!int(r.elf_moments || 0, 0, 3)) return "elf_moments";
  if (r.elf_kind && ["fill", "replace", "both"].indexOf(r.elf_kind) < 0) return "elf_kind";
  if (r.elf_done && ["fill", "replace"].indexOf(r.elf_done) < 0) return "elf_done";

  // цифры на поле: от 3 до 5 открытых, без повторов
  const g = r.grid.split("").map(Number);
  const known = g.filter(Boolean);
  if (new Set(known).size !== known.length) return "repeated digit";
  if (known.length < 3 || known.length > 5) return "digits count";
  const free = [1,2,3,4,5,6,7,8,9].filter(d => known.indexOf(d) < 0);

  // выпавшая сумма должна собираться из открытых цифр линии и оставшихся цифр
  let knownSum = 0, closed = 0;
  LINES[r.line].forEach(i => { if (g[i]) knownSum += g[i]; else closed++; });
  if (!canMake(free, closed, r.line_sum - knownSum)) return "impossible sum";

  // очки должны соответствовать сумме
  if (r.score !== PAY[r.line_sum]) return "wrong score";
  return "";
}

// Можно ли набрать need из k разных цифр списка free
function canMake(free, k, need) {
  if (k === 0) return need === 0;
  for (let i = 0; i < free.length; i++) {
    if (canMake(free.slice(i + 1), k - 1, need - free[i])) return true;
  }
  return false;
}

// ---------- Статистика ----------
// Общая сводка и личная статистика лежат в кэше по минуте; если обе есть — таблицу не читаем.
// После записи партии кэш сбрасывается (см. addGame)
function getStats(player) {
  const cache = CacheService.getScriptCache();
  const fromCache = k => { const v = cache.get(k); return v ? JSON.parse(v) : null; };
  let stats = fromCache("stats");
  let me = player ? fromCache("me:" + player) : null;
  if (stats && (!player || me)) return { stats, me };
  const rows = readGames();
  if (!stats) {
    stats = summarize(rows);
    stats.started = Math.max(0, sheet(STARTS, START_COLS).getLastRow() - 1);
    cache.put("stats", JSON.stringify(stats), STATS_TTL);
  }
  if (player && !me) {
    me = summarizeMe(rows.filter(r => String(r.player) === player));
    cache.put("me:" + player, JSON.stringify(me), STATS_TTL);
  }
  return { stats, me };
}

// Партии с листа; столбцы — по заголовкам (подходит и для импорта из Supabase)
function readGames() {
  const sh = sheet(GAMES, GAME_COLS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const header = headerOf(sh);
  return sh.getRange(2, 1, n, header.length).getValues().map(v => {
    const o = {};
    header.forEach((c, i) => { o[c] = v[i]; });
    o.score = Number(o.score) || 0;
    return o;
  });
}

const avg = (rows, f) => rows.length ? rows.reduce((a, r) => a + f(r), 0) / rows.length : 0;
const cnt = (rows, f) => rows.filter(f).length;
const sum2 = (rows, f) => Math.round(100 * rows.reduce((a, r) => a + f(r), 0)) / 100;
const pct = (rows, f) => Math.round(100 * avg(rows, r => f(r) ? 1 : 0));
const pct1 = v => Math.round(1000 * v) / 10;
const isTrue = v => v === true || String(v).toLowerCase() === "true";
const moments = r => Math.max(Number(r.elf_moments) || 0, isTrue(r.elf_possible) ? 1 : 0);

// Группы: джекпот 1008–1680, крупный 420–840, средний 105–280, мелкий 34–84
function summarize(rows) {
  const jack = r => r.score >= 1008, big = r => r.score >= 420 && r.score < 1008,
        mid = r => r.score >= 100 && r.score < 420, small = r => r.score < 100;
  const kind = r => String(r.elf_kind || ""), done = r => String(r.elf_done || "");
  return {
    games: rows.length,
    avg_score: Math.round(avg(rows, r => r.score)),
    avg_expected: Math.round(avg(rows, r => Number(r.expected) || 0)),
    jack_n: cnt(rows, jack), big_n: cnt(rows, big), mid_n: cnt(rows, mid), small_n: cnt(rows, small),
    jack_pct: pct1(avg(rows, r => jack(r) ? 1 : 0)), big_pct: pct(rows, big), mid_pct: pct(rows, mid), small_pct: pct(rows, small),
    jack_exp: pct1(avg(rows, r => Number(r.p_jack) || 0)),
    big_exp: Math.round(100 * avg(rows, r => Number(r.p_big) || 0)),
    mid_exp: Math.round(100 * avg(rows, r => Number(r.p_mid) || 0)),
    small_exp: Math.round(100 * avg(rows, r => 1 - (Number(r.p_jack) || 0) - (Number(r.p_big) || 0) - (Number(r.p_mid) || 0))),
    // сколько партий каждой группы должно было выпасть по расчёту — сумма шансов, без округления
    jack_exp_n: sum2(rows, r => Number(r.p_jack) || 0),
    big_exp_n: sum2(rows, r => Number(r.p_big) || 0),
    mid_exp_n: sum2(rows, r => Number(r.p_mid) || 0),
    small_exp_n: sum2(rows, r => 1 - (Number(r.p_jack) || 0) - (Number(r.p_big) || 0) - (Number(r.p_mid) || 0)),
    elf_chances: rows.reduce((a, r) => a + moments(r), 0),
    elf_n: cnt(rows, r => isTrue(r.elf_shown)),
    fill_chances: cnt(rows, r => kind(r) === "fill" || kind(r) === "both"),
    fill_n: cnt(rows, r => done(r) === "fill"),
    repl_chances: cnt(rows, r => kind(r) === "replace" || kind(r) === "both"),
    repl_n: cnt(rows, r => done(r) === "replace"),
    reported: cnt(rows, r => !!r.game_id)
  };
}

function summarizeMe(rows) {
  return {
    games: rows.length,
    total: rows.reduce((a, r) => a + r.score, 0),
    avg_score: Math.round(avg(rows, r => r.score)),
    avg_expected: Math.round(avg(rows, r => Number(r.expected) || 0)),
    elf_chances: rows.reduce((a, r) => a + moments(r), 0),
    elf_n: cnt(rows, r => isTrue(r.elf_shown))
  };
}
