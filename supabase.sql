-- Статистика моментальной лотереи.
-- Выполнить один раз: Supabase → SQL Editor → вставить весь файл → Run.

create table public.games (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  player        text     not null check (length(player) between 1 and 20),   -- анонимный id браузера
  grid          text     not null check (grid ~ '^[0-9]{9}$'),               -- поле в конце партии, 0 = закрыта
  line          smallint not null check (line between 0 and 7),              -- выбранная линия
  best_line     smallint not null check (best_line between 0 and 7),         -- линия, которую советовал калькулятор
  line_sum      smallint not null check (line_sum between 6 and 24),         -- выпавшая сумма
  score         integer  not null check (score between 0 and 10000),         -- полученные очки
  expected      integer  not null check (expected between 0 and 10000),      -- средний выигрыш выбранной линии по расчёту
  best_expected integer  not null check (best_expected between 0 and 10000), -- средний выигрыш лучшей линии
  p_jack        real     not null default 0 check (p_jack between 0 and 1),  -- шанс джекпота (1-2-3 или 7-8-9) по расчёту
  p_big         real     not null check (p_big between 0 and 1),             -- шанс крупного выигрыша (420–840) по расчёту
  p_mid         real     not null check (p_mid between 0 and 1),             -- шанс среднего (105–280) по расчёту
  elf_possible  boolean  not null,                                           -- фея могла появиться
  elf_shown     boolean  not null check (elf_possible or not elf_shown)      -- фея появилась
);

-- Посетители сайта могут только добавлять партии: читать и менять таблицу нельзя
alter table public.games enable row level security;
create policy "anyone can add a game" on public.games for insert to anon with check (true);
grant insert on public.games to anon;

-- Сводка для блока «Статистика игроков»
create view public.games_stats as
select
  count(*)::int                                                       as games,
  count(distinct player)::int                                         as players,
  coalesce(round(avg(score)), 0)::int                                 as avg_score,
  coalesce(round(avg(expected)), 0)::int                              as avg_expected,
  -- погрешность разницы «получили − ожидали»: чем больше партий, тем она меньше
  coalesce(round(stddev_samp(score - expected) / sqrt(count(*))), 0)::int as se,
  coalesce(round(100.0 * avg((line = best_line)::int)), 0)::int       as followed_pct,
  (count(*) filter (where line = best_line))::int                     as n_followed,
  coalesce(round(avg(score) filter (where line = best_line)), 0)::int as avg_followed,
  (count(*) filter (where line <> best_line))::int                    as n_other,
  coalesce(round(avg(score) filter (where line <> best_line)), 0)::int as avg_other,
  -- как часто выпадали группы выигрышей и как часто должны были:
  -- джекпот 1008–1680 (1-2-3, 7-8-9), крупный 420–840, средний 105–280, мелкий 34–84
  (count(*) filter (where score >= 420 and score < 1008))::int              as big_n,
  (count(*) filter (where score >= 100 and score < 420))::int               as mid_n,
  (count(*) filter (where score < 100))::int                                as small_n,
  coalesce(round(100.0 * avg((score >= 420 and score < 1008)::int)), 0)::int as big_pct,
  coalesce(round(100.0 * avg(p_big)), 0)::int                               as big_exp,
  coalesce(round(100.0 * avg((score >= 100 and score < 420)::int)), 0)::int as mid_pct,
  coalesce(round(100.0 * avg(p_mid)), 0)::int                               as mid_exp,
  coalesce(round(100.0 * avg((score < 100)::int)), 0)::int                  as small_pct,
  coalesce(round(100.0 * avg(1 - p_jack - p_big - p_mid)), 0)::int         as small_exp,
  -- фея: сколько раз могла появиться и сколько появилась
  (count(*) filter (where elf_possible))::int                               as elf_chances,
  (count(*) filter (where elf_shown))::int                                  as elf_n,
  (count(*) filter (where score >= 1008))::int                              as jack_n,
  coalesce(round(100.0 * avg((score >= 1008)::int), 1), 0)::real           as jack_pct,
  coalesce(round(100.0 * avg(p_jack)::numeric, 1), 0)::real                as jack_exp
from public.games;

grant select on public.games_stats to anon;

-- Личные результаты одного игрока (по его анонимному id)
create function public.player_stats(p text)
returns table (games int, total int, avg_score int, avg_expected int, elf_chances int, elf_n int)
language sql stable security definer set search_path = public as $$
  select count(*)::int,
         coalesce(sum(score), 0)::int,
         coalesce(round(avg(score)), 0)::int,
         coalesce(round(avg(expected)), 0)::int,
         (count(*) filter (where elf_possible))::int,
         (count(*) filter (where elf_shown))::int
  from games
  where player = p
$$;

grant execute on function public.player_stats(text) to anon;
