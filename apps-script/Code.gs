// Хранилище статистики моментальной лотереи в Google Таблице.
// Калькулятор шлёт сюда POST с JSON вида {action, ...}: "start", "game" или "stats".
// Запрос "stats" приходит при каждом открытии сайта — по нему же считаем посещения: уникальных
// людей по дням (лист «visits») и все открытия страницы по дням (лист «opens», пометка open).
// Установка: Расширения → Apps Script → вставить этот файл → Начать развёртывание →
// Веб-приложение, «Запуск от имени: я», «Доступ: все».
// Листы «games», «starts» и «settings» создаются сами. На «settings» — номер сезона (season) и
// открыт ли он (open: TRUE/FALSE). Пока сезон закрыт, партии не записываются, а посещения — да.
// Сезон идёт неделю: с пятницы 3:00 МСК (00:00 UTC) до следующей пятницы. При открытии скрипт сам
// пишет в «settings» дату старта (start) и через 7 дней перестаёт принимать партии, даже если open = TRUE.
// Можно заранее импортировать на «games» и «starts» выгрузку
// из Supabase: столбцы ищутся по заголовкам, лишние не мешают.

const GAMES = "games";
const STARTS = "starts";
const GAME_COLS = ["created_at", "game_id", "player", "grid", "line", "best_line", "line_sum", "score",
  "expected", "best_expected", "p_jack", "p_big", "p_mid", "elf_possible", "elf_shown", "elf_moments",
  "elf_kind", "elf_done", "lang", "elf_lines", "season"];
const START_COLS = ["created_at", "game_id", "player", "season"];
const SETTINGS = "settings";
const VISITS = "visits";
const VISIT_COLS = ["created_at", "day", "player"];
const OPENS = "opens";
const OPEN_COLS = ["day", "opens"];

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
    if (body.action === "stats") {
      const player = String(body.player || "");
      noteVisit(player, body.open === true);
      return reply(getStats(player));
    }
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

// ---------- Сезон ----------
const DAY = 86400000, WEEK = 7 * DAY;

// Начало недели ивента: пятница 00:00 UTC (= 3:00 МСК) в момент ms или раньше
function fridayStart(ms) {
  const d = new Date(ms);
  const back = (d.getUTCDay() - 5 + 7) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

// Настройки с листа «settings»: столбец A — название, B — значение. Читаем не чаще раза в 15 секунд.
// open в ответе — с учётом недели: после пятницы 3:00 МСК сезон закрыт, даже если в таблице TRUE
function seasonSettings() {
  const cache = CacheService.getScriptCache();
  const c = cache.get("settings");
  if (c) return JSON.parse(c);
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sh = book.getSheetByName(SETTINGS);
  if (!sh) {
    sh = book.insertSheet(SETTINGS);
    sh.appendRow(["setting", "value"]);
    sh.appendRow(["season", 1]);
    sh.appendRow(["open", false]);
  }
  const vals = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 2).getValues();
  const row = k => vals.findIndex(v => String(v[0]).trim().toLowerCase() === k);
  const get = k => { const i = row(k); return i < 0 ? "" : vals[i][1]; };
  const put = (k, v) => { const i = row(k); if (i < 0) sh.appendRow([k, v]); else sh.getRange(i + 1, 2).setValue(v); };
  const season = Math.max(1, Math.floor(Number(get("season")) || 1));
  const wantOpen = isTrue(get("open"));
  // Дата старта своя у каждого сезона. Нет её — при открытии берём ближайшую пятницу
  let startMs = NaN;
  if (Number(get("start_season")) === season) {
    const v = get("start");
    startMs = v instanceof Date ? Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()) : Date.parse(String(v).trim().slice(0, 10) + "T00:00:00Z");
  }
  if (wantOpen && isNaN(startMs)) {
    const now = Date.now(), prev = fridayStart(now), next = prev + WEEK;
    startMs = now - prev <= next - now ? prev : next;
    put("start", "'" + isoDay(startMs));
    put("start_season", season);
  }
  const set = {
    season,
    open: wantOpen && !isNaN(startMs) && Date.now() < startMs + WEEK,
    start: isNaN(startMs) ? "" : isoDay(startMs),
    end: isNaN(startMs) ? "" : isoDay(startMs + WEEK)
  };
  cache.put("settings", JSON.stringify(set), 15);
  return set;
}

// Сезон записи; у старых строк его нет — это первый сезон
const seasonOf = r => Math.max(1, Math.floor(Number(r.season) || 1));

// ---------- Первый этап: партия дошла до выбора линии ----------
function addStart(row) {
  const player = String(row.player || "");
  const gameId = String(row.game_id || "");
  if (player.length < 1 || player.length > 20 || !/^[0-9a-f-]{36}$/i.test(gameId)) return { error: "bad_game: start" };
  const set = seasonSettings();
  if (!set.open) return { error: "closed" };
  const cache = CacheService.getScriptCache();
  if (cache.get("sid:" + gameId)) return { ok: true, duplicate: true };
  if (cache.get("s:" + player)) return { error: "rate_limit" };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    appendByHeader(sheet(STARTS, START_COLS), { created_at: new Date(), game_id: gameId, player, season: set.season });
    cache.put("sid:" + gameId, "1", 21600);
    cache.put("s:" + player, "1", START_GAP);
  } finally { lock.releaseLock(); }
  return { ok: true };
}

// ---------- Второй этап: результат партии ----------
function addGame(r) {
  const bad = checkGame(r);
  if (bad) return { error: "bad_game: " + bad };
  const set = seasonSettings();
  if (!set.open) return { error: "closed" };
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
      elf_kind: r.elf_kind || "", elf_done: r.elf_done || "", elf_lines: r.elf_lines || 0,
      lang: r.lang || "",  // язык сайта, на котором сыграна партия; на сайте не показывается
      season: set.season
    });
    if (r.game_id) cache.put("gid:" + r.game_id, "1", 21600);
    cache.put("g:" + r.player, "1", GAME_GAP);
    cache.remove("stats2");
    cache.remove("me2:" + r.player);
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
  if (r.elf_lines !== undefined && !int(r.elf_lines, 0, 8)) return "elf_lines";
  if (r.lang && ["ru", "en"].indexOf(r.lang) < 0) return "lang";

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
// Посещение: одна строка на игрока в день. Если записать не вышло — статистику всё равно отдаём
function noteVisit(player, open) {
  if (player.length < 1 || player.length > 20) return;
  try {
    const day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    if (open) countOpen(day);
    const cache = CacheService.getScriptCache();
    const key = "v:" + day + ":" + player;
    if (cache.get(key)) return;
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return;
    try {
      appendByHeader(sheet(VISITS, VISIT_COLS), { created_at: new Date(), day: day, player });
      // Кэш живёт не дольше 6 часов, поэтому за день у игрока может набраться 2–4 строки — для подсчёта по дням это не мешает
      cache.put(key, "1", 21600);
    } finally { lock.releaseLock(); }
  } catch (err) { /* посещение не записалось — не страшно */ }
}

// Открытия страницы: одна строка на день, в ней счётчик
function countOpen(day) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const sh = sheet(OPENS, OPEN_COLS);
    const last = sh.getLastRow();
    const header = headerOf(sh);
    const dc = header.indexOf("day") + 1, oc = header.indexOf("opens") + 1;
    if (last > 1) {
      const v = sh.getRange(last, dc).getValue();
      const lastDay = v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd") : String(v);
      if (lastDay === day) {
        const cell = sh.getRange(last, oc);
        cell.setValue(Number(cell.getValue() || 0) + 1);
        return;
      }
    }
    appendByHeader(sh, { day, opens: 1 });
  } finally { lock.releaseLock(); }
}

// Сводка по каждому сезону. stats/me — сезон, который сайт показывает по умолчанию (для старых версий сайта)
function getStats(player) {
  const set = seasonSettings();
  const cache = CacheService.getScriptCache();
  const fromCache = k => { const v = cache.get(k); return v ? JSON.parse(v) : null; };
  let all = fromCache("stats2");
  let mine = player ? fromCache("me2:" + player) : null;
  if (!all || (player && !mine)) {
    const rows = readGames();
    if (!all) {
      all = {};
      const groups = {};
      rows.forEach(r => (groups[seasonOf(r)] = groups[seasonOf(r)] || []).push(r));
      const started = startsBySeason();
      Object.keys(groups).forEach(k => {
        const g = groups[k];
        all[k] = summarize(g);
        all[k].started = started[k] || 0;
        // Даты — неделя ивента: у текущего сезона из настроек, у прошлых — по первой партии
        const first = Math.min(...g.map(r => timeOf(r.created_at)).filter(t => !isNaN(t)));
        const st = Number(k) === set.season && set.start ? Date.parse(set.start + "T00:00:00Z") : (isFinite(first) ? fridayStart(first) : NaN);
        all[k].from = isNaN(st) ? "" : isoDay(st);
        all[k].to = isNaN(st) ? "" : isoDay(st + WEEK);
      });
      cache.put("stats2", JSON.stringify(all), STATS_TTL);
    }
    if (player && !mine) {
      mine = {};
      const my = rows.filter(r => String(r.player) === player);
      Object.keys(all).forEach(k => { mine[k] = summarizeMe(my.filter(r => String(seasonOf(r)) === k)); });
      cache.put("me2:" + player, JSON.stringify(mine), STATS_TTL);
    }
  }
  const have = Object.keys(all).map(Number).filter(k => all[k].games);
  const def = all[set.season] && all[set.season].games ? set.season : (have.length ? Math.max(...have) : set.season);
  return { stats: all[def] || null, me: mine ? mine[def] || null : null,
    season: set.season, open: set.open, start: set.start, end: set.end, seasons: all, me_seasons: mine };
}

// Время записи в миллисекундах; у строк, импортированных из Supabase, оно строкой вида «2026-10-02 20:56:45+00»
function timeOf(v) {
  if (v instanceof Date) return v.getTime();
  const m = String(v || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? Date.parse(m[1] + "T" + m[2] + "Z") : NaN;
}

// Сколько партий дошло до выбора линии — по сезонам
function startsBySeason() {
  const sh = sheet(STARTS, START_COLS);
  const n = sh.getLastRow() - 1;
  const out = {};
  if (n < 1) return out;
  const header = headerOf(sh);
  const sc = header.indexOf("season");
  const vals = sc < 0 ? [] : sh.getRange(2, sc + 1, n, 1).getValues();
  for (let i = 0; i < n; i++) { const k = seasonOf({ season: sc < 0 ? "" : vals[i][0] }); out[k] = (out[k] || 0) + 1; }
  return out;
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
