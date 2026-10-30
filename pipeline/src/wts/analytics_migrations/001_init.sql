-- analytics.db (analytics design §2.1): the Worker's Analytics Engine points, copied by
-- `wts analytics pull`, kept past Cloudflare's ~3 months.
create table points (
  env text not null,          -- staging | production
  kind text not null,         -- search | report
  ts text not null,           -- 'YYYY-MM-DD HH:MM:SS', UTC, as Analytics Engine returns it
  q text, mode text, sort text, cache text,
  results real, ms real, degraded real, page real, status real,
  traffic text not null default '',  -- pipeline | maintainer | web; '' before 2026-10-30
  sample real not null default 1     -- _sample_interval: how many requests this point stands for
);
create index points_env_ts on points (env, ts);

create table pulls (
  env text not null,
  at text not null,           -- when the pull ran, ISO 8601 UTC
  from_ts text not null,
  to_ts text not null,
  rows integer not null
);
