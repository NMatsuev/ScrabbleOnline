create table if not exists public.rooms (
  code        text   primary key,
  data        jsonb  not null,          -- полное состояние комнаты (доска, мешок, стойки, таймеры)
  updated_at  bigint not null           -- мс с 1970 года
);

create table if not exists public.results (
  id           bigint generated always as identity primary key,
  room_code    text   not null,
  mode         text   not null,
  board_size   int    not null,
  target       int    not null,
  started_at   bigint not null,
  finished_at  bigint not null,
  end_reason   text   not null,
  winners      jsonb  not null,
  ranking      jsonb  not null,
  words        jsonb  not null
);

-- Закрываем таблицы от публичного ключа (anon): доступ только у сервера с ключом service_role.
alter table public.rooms   enable row level security;
alter table public.results enable row level security;
