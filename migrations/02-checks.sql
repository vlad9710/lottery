-- Проверка партий в самой базе, ограничение частоты и двухэтапная запись.
-- Выполнить один раз: Supabase → SQL Editor → вставить весь файл → Run.

-- 1. Двухэтапная запись: «дошёл до выбора линии» (starts) и «отметил результат» (games)
alter table public.games add column if not exists game_id uuid unique;

-- Сколько раз за партию фея могла появиться (после каждого открытия — свой шанс)
alter table public.games add column if not exists elf_moments smallint not null default 0
  check (elf_moments between 0 and 3);

create table if not exists public.starts (
  game_id    uuid primary key,
  player     text not null check (length(player) between 1 and 20),
  created_at timestamptz not null default now()
);
alter table public.starts enable row level security;
drop policy if exists "anyone can start a game" on public.starts;
create policy "anyone can start a game" on public.starts for insert to anon with check (true);
grant insert on public.starts to anon;

-- 2. Таблица выплат: очки за сумму линии
create or replace function public.lottery_pay(s int) returns int
language sql immutable as $$
  select case s
    when 6 then 1680 when 7 then 84 when 8 then 630 when 9 then 280 when 10 then 42
    when 11 then 34 when 12 then 180 when 13 then 120 when 14 then 53 when 15 then 105
    when 16 then 53 when 17 then 144 when 18 then 48 when 19 then 202 when 20 then 105
    when 21 then 51 when 22 then 420 when 23 then 840 when 24 then 1008
  end
$$;

-- 3. Проверка каждой партии перед записью
create or replace function public.games_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  lines constant int[] := array[[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6],[6,7,8],[3,4,5],[0,1,2]];
  known int[] := '{}';
  free  int[] := '{}';
  d int; known_sum int := 0; closed int := 0; need int; ok boolean;
begin
  -- цифры на поле: от 3 до 5 открытых, без повторов
  for i in 0..8 loop
    d := substr(new.grid, i + 1, 1)::int;
    if d > 0 then
      if d = any(known) then raise exception 'bad_game: repeated digit'; end if;
      known := known || d;
    end if;
  end loop;
  if cardinality(known) not between 3 and 5 then raise exception 'bad_game: digits count'; end if;
  for d in 1..9 loop
    if not d = any(known) then free := free || d; end if;
  end loop;

  -- выпавшая сумма должна собираться из открытых цифр линии и оставшихся цифр
  for i in 1..3 loop
    d := substr(new.grid, lines[new.line + 1][i] + 1, 1)::int;
    if d > 0 then known_sum := known_sum + d; else closed := closed + 1; end if;
  end loop;
  need := new.line_sum - known_sum;
  ok := case closed
    when 0 then need = 0
    when 1 then need = any(free)
    when 2 then exists (select 1 from unnest(free) a, unnest(free) b where a < b and a + b = need)
    else exists (select 1 from unnest(free) a, unnest(free) b, unnest(free) c where a < b and b < c and a + b + c = need)
  end;
  if not ok then raise exception 'bad_game: impossible sum'; end if;

  -- очки должны соответствовать сумме
  if new.score <> lottery_pay(new.line_sum) then raise exception 'bad_game: wrong score'; end if;

  -- не чаще одной партии в 15 секунд с одного устройства
  if exists (select 1 from games where player = new.player and created_at > now() - interval '15 seconds') then
    raise exception 'rate_limit';
  end if;
  return new;
end
$$;

drop trigger if exists games_check on public.games;
create trigger games_check before insert on public.games for each row execute function public.games_check();

-- 4. Ограничение частоты для первого этапа
create or replace function public.starts_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from starts where player = new.player and created_at > now() - interval '10 seconds') then
    raise exception 'rate_limit';
  end if;
  return new;
end
$$;

drop trigger if exists starts_check on public.starts;
create trigger starts_check before insert on public.starts for each row execute function public.starts_check();

-- 5. Сводка: добавлены started и reported, фея считается по моментам
create or replace view public.games_stats as
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
  coalesce(sum(greatest(elf_moments, elf_possible::int)), 0)::int          as elf_chances,
  (count(*) filter (where elf_shown))::int                                  as elf_n,
  (count(*) filter (where score >= 1008))::int                              as jack_n,
  coalesce(round(100.0 * avg((score >= 1008)::int), 1), 0)::real           as jack_pct,
  coalesce(round(100.0 * avg(p_jack)::numeric, 1), 0)::real                as jack_exp,
  -- двухэтапная запись: сколько партий дошли до выбора линии и сколько из них с результатом
  (select count(*) from public.starts)::int                                 as started,
  (count(*) filter (where game_id is not null))::int                        as reported
from public.games;

-- 6. Личная статистика: фея тоже по моментам
create or replace function public.player_stats(p text)
returns table (games int, total int, avg_score int, avg_expected int, elf_chances int, elf_n int)
language sql stable security definer set search_path = public as $$
  select count(*)::int,
         coalesce(sum(score), 0)::int,
         coalesce(round(avg(score)), 0)::int,
         coalesce(round(avg(expected)), 0)::int,
         coalesce(sum(greatest(elf_moments, elf_possible::int)), 0)::int,
         (count(*) filter (where elf_shown))::int
  from games
  where player = p
$$;
