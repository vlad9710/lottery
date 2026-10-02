-- Джекпот отдельной группой в статистике.
-- Выполнить один раз: Supabase → SQL Editor → вставить весь файл → Run.

alter table public.games
  add column if not exists p_jack real not null default 0 check (p_jack between 0 and 1);

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
  (count(*) filter (where elf_possible))::int                               as elf_chances,
  (count(*) filter (where elf_shown))::int                                  as elf_n,
  (count(*) filter (where score >= 1008))::int                              as jack_n,
  coalesce(round(100.0 * avg((score >= 1008)::int), 1), 0)::real           as jack_pct,
  coalesce(round(100.0 * avg(p_jack)::numeric, 1), 0)::real                as jack_exp
from public.games;
