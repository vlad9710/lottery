-- Фея: отдельно «поставить в закрытую клетку» и «заменить открытую цифру».
-- Выполнить один раз: Supabase → SQL Editor → вставить весь файл → Run. Можно запускать повторно.

-- 1. Новые поля: какие случаи феи были возможны и что она сделала
alter table public.games add column if not exists elf_kind text check (elf_kind in ('fill', 'replace', 'both'));
alter table public.games add column if not exists elf_done text check (elf_done in ('fill', 'replace'));

-- 2. Какие случаи феи возможны на поле после всех открытий:
--    в линии две цифры из 1-2-3 (или 7-8-9), недостающей нигде нет;
--    третья клетка закрыта — «fill», открыта с неподходящей цифрой — «replace»
create or replace function public.elf_kind_of(g text) returns text
language plpgsql immutable as $$
declare
  lines constant int[] := array[[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6],[6,7,8],[3,4,5],[0,1,2]];
  d int[]; lo int; hi int; have int; have_sum int; third int; miss int; v int;
  can_fill boolean := false; can_repl boolean := false;
begin
  d := array(select substr(g, k, 1)::int from generate_series(1, 9) k);
  foreach lo in array array[1, 7] loop
    hi := lo + 2;
    for l in 1..8 loop
      have := 0; have_sum := 0; third := -1;
      for i in 1..3 loop
        v := d[lines[l][i] + 1];
        if v between lo and hi then have := have + 1; have_sum := have_sum + v; else third := v; end if;
      end loop;
      if have = 2 then
        miss := 3 * (lo + 1) - have_sum;
        if not (miss = any(d)) then
          if third = 0 then can_fill := true; else can_repl := true; end if;
        end if;
      end if;
    end loop;
  end loop;
  return case when can_fill and can_repl then 'both' when can_fill then 'fill' when can_repl then 'replace' end;
end
$$;

-- 3. Заполняем уже записанные партии
-- Без феи на поле её цифры нет — случаи определяются по полю как есть
update public.games set elf_kind = public.elf_kind_of(grid)
where not elf_shown and elf_kind is null;
-- С феей её цифра уже на поле. Если цифр пять — она встала в закрытую клетку;
-- если четыре и линия собрана — заменила открытую; иначе цифру просто не вписали — закрытая клетка
update public.games g set
  elf_done = x.done, elf_kind = x.done
from (
  select id, case
    when length(replace(grid, '0', '')) = 5 then 'fill'
    when exists (
      select 1 from (values (1,4,7),(2,5,8),(3,6,9),(1,5,9),(3,5,7),(7,8,9),(4,5,6),(1,2,3)) as l(a, b, c)
      where (substr(grid, l.a, 1) || substr(grid, l.b, 1) || substr(grid, l.c, 1)) in ('123','132','213','231','312','321','789','798','879','897','978','987')
    ) then 'replace'
    else 'fill' end as done
  from public.games where elf_shown and elf_done is null
) x
where g.id = x.id;

-- 4. Сводка: добавлены счётчики по типам случаев
create or replace view public.games_stats as
select
  count(*)::int                                                       as games,
  count(distinct player)::int                                         as players,
  coalesce(round(avg(score)), 0)::int                                 as avg_score,
  coalesce(round(avg(expected)), 0)::int                              as avg_expected,
  coalesce(round(stddev_samp(score - expected) / sqrt(count(*))), 0)::int as se,
  coalesce(round(100.0 * avg((line = best_line)::int)), 0)::int       as followed_pct,
  (count(*) filter (where line = best_line))::int                     as n_followed,
  coalesce(round(avg(score) filter (where line = best_line)), 0)::int as avg_followed,
  (count(*) filter (where line <> best_line))::int                    as n_other,
  coalesce(round(avg(score) filter (where line <> best_line)), 0)::int as avg_other,
  (count(*) filter (where score >= 420 and score < 1008))::int              as big_n,
  (count(*) filter (where score >= 100 and score < 420))::int               as mid_n,
  (count(*) filter (where score < 100))::int                                as small_n,
  coalesce(round(100.0 * avg((score >= 420 and score < 1008)::int)), 0)::int as big_pct,
  coalesce(round(100.0 * avg(p_big)), 0)::int                               as big_exp,
  coalesce(round(100.0 * avg((score >= 100 and score < 420)::int)), 0)::int as mid_pct,
  coalesce(round(100.0 * avg(p_mid)), 0)::int                               as mid_exp,
  coalesce(round(100.0 * avg((score < 100)::int)), 0)::int                  as small_pct,
  coalesce(round(100.0 * avg(1 - p_jack - p_big - p_mid)), 0)::int         as small_exp,
  coalesce(sum(greatest(elf_moments, elf_possible::int)), 0)::int          as elf_chances,
  (count(*) filter (where elf_shown))::int                                  as elf_n,
  (count(*) filter (where score >= 1008))::int                              as jack_n,
  coalesce(round(100.0 * avg((score >= 1008)::int), 1), 0)::real           as jack_pct,
  coalesce(round(100.0 * avg(p_jack)::numeric, 1), 0)::real                as jack_exp,
  (select count(*) from public.starts)::int                                 as started,
  (count(*) filter (where game_id is not null))::int                        as reported,
  -- фея по типам: сколько раз могла и сколько раз сделала
  (count(*) filter (where elf_kind in ('fill', 'both')))::int               as fill_chances,
  (count(*) filter (where elf_done = 'fill'))::int                          as fill_n,
  (count(*) filter (where elf_kind in ('replace', 'both')))::int            as repl_chances,
  (count(*) filter (where elf_done = 'replace'))::int                       as repl_n
from public.games;
