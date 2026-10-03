-- Voyz cloud schema 1. Apply once in a dedicated Supabase project as postgres.
-- Expose only public through the Data API; never expose voyz_private.
begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'extensions' and p.proname = 'gen_random_bytes'
  ) then
    raise exception 'Enable pgcrypto in the extensions schema before applying this migration.';
  end if;
end $$;

create schema voyz_private;
revoke all on schema voyz_private from public, anon, authenticated;
grant usage on schema voyz_private to anon, authenticated;

create table public.voyz_tours (
  owner_id uuid not null references auth.users(id) on delete cascade,
  tour_id text not null check (tour_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  document jsonb not null,
  revision bigint not null check (revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  primary key (owner_id, tour_id),
  check (jsonb_typeof(document) is not distinct from 'object'),
  check (document->>'kind' is not distinct from 'voyz-tour'),
  check (document->>'version' is not distinct from '2'),
  check (document->>'id' is not distinct from tour_id)
);
create index voyz_tours_owner_updated on public.voyz_tours(owner_id, updated_at);
alter table public.voyz_tours enable row level security;
revoke all on table public.voyz_tours from public, anon, authenticated;
grant select on table public.voyz_tours to authenticated;
create policy voyz_owner_read on public.voyz_tours
  for select to authenticated using (owner_id = (select auth.uid()));

create table voyz_private.shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  tour_id text not null,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  foreign key (owner_id, tour_id) references public.voyz_tours(owner_id, tour_id) on delete cascade
);
create index voyz_shares_owner_tour on voyz_private.shares(owner_id, tour_id);
alter table voyz_private.shares enable row level security;
revoke all on table voyz_private.shares from public, anon, authenticated;

-- This validator protects the transport boundary. The app still normalizes all
-- nested values before rendering, including URLs, money, positions, and images.
create function voyz_private.validate_tour(p_id text, p_document jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare d jsonb; e jsonb; k text;
begin
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{1,100}$'
    or jsonb_typeof(p_document) is distinct from 'object'
    or p_document->>'kind' is distinct from 'voyz-tour'
    or p_document->>'version' is distinct from '2'
    or p_document->>'id' is distinct from p_id
    or jsonb_typeof(p_document->'tour') is distinct from 'object'
    or jsonb_typeof(p_document#>'{tour,title}') is distinct from 'string'
    or length(p_document#>>'{tour,title}') > 300
    or jsonb_typeof(p_document#>'{tour,startDate}') is distinct from 'string'
    or jsonb_typeof(p_document#>'{tour,endDate}') is distinct from 'string'
    or jsonb_typeof(p_document->'days') is distinct from 'array'
    or octet_length(p_document::text) > 33554432 then
    raise exception 'INVALID_DOCUMENT' using errcode = '22023';
  end if;
  if jsonb_array_length(p_document->'days') > 100 then
    raise exception 'INVALID_DOCUMENT' using errcode = '22023';
  end if;
  for d in select value from jsonb_array_elements(p_document->'days') loop
    if jsonb_typeof(d) is distinct from 'object'
      or jsonb_typeof(d->'id') is distinct from 'string'
      or jsonb_typeof(d->'schedule') is distinct from 'array' then
      raise exception 'INVALID_DOCUMENT' using errcode = '22023';
    end if;
    if jsonb_array_length(d->'schedule') > 100 then
      raise exception 'INVALID_DOCUMENT' using errcode = '22023';
    end if;
    foreach k in array array['title','description','photo','photoCredit','note','planB',
      'noteTitle','planBTitle','lodgingName','lodgingUrl'] loop
      if d ? k and jsonb_typeof(d->k) is distinct from 'string' then
        raise exception 'INVALID_DOCUMENT' using errcode = '22023';
      end if;
    end loop;
    foreach k in array array['width','x','y'] loop
      if d ? k and jsonb_typeof(d->k) is distinct from 'number' then
        raise exception 'INVALID_DOCUMENT' using errcode = '22023';
      end if;
    end loop;
    for e in select value from jsonb_array_elements(d->'schedule') loop
      if jsonb_typeof(e) is distinct from 'object'
        or jsonb_typeof(e->'id') is distinct from 'string'
        or jsonb_typeof(e->'time') is distinct from 'string'
        or jsonb_typeof(e->'text') is distinct from 'string' then
        raise exception 'INVALID_DOCUMENT' using errcode = '22023';
      end if;
    end loop;
  end loop;
  if p_document ? 'connections' then
    if jsonb_typeof(p_document->'connections') is distinct from 'array' then
      raise exception 'INVALID_DOCUMENT' using errcode = '22023';
    end if;
    if jsonb_array_length(p_document->'connections') > 500 then
      raise exception 'INVALID_DOCUMENT' using errcode = '22023';
    end if;
    for d in select value from jsonb_array_elements(p_document->'connections') loop
      if jsonb_typeof(d) is distinct from 'object' then
        raise exception 'INVALID_DOCUMENT' using errcode = '22023';
      end if;
      foreach k in array array['id','from','to','fromPort','toPort','style','color','label'] loop
        if jsonb_typeof(d->k) is distinct from 'string' then
          raise exception 'INVALID_DOCUMENT' using errcode = '22023';
        end if;
      end loop;
    end loop;
  end if;
  if p_document ? 'view' and (jsonb_typeof(p_document->'view') is distinct from 'object'
    or jsonb_typeof(p_document#>'{view,zoom}') is distinct from 'number') then
    raise exception 'INVALID_DOCUMENT' using errcode = '22023';
  end if;
end $$;

create function voyz_private.put_tour(p_tour_id text, p_expected bigint, p_document jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_row public.voyz_tours%rowtype;
begin
  if v_owner is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_expected is null or p_expected < 0 then
    raise exception 'INVALID_REVISION' using errcode = '22023';
  end if;
  perform voyz_private.validate_tour(p_tour_id, p_document);
  update public.voyz_tours
  set document = p_document, revision = revision + 1, updated_at = clock_timestamp()
  where owner_id = v_owner and tour_id = p_tour_id
    and revision = p_expected and deleted_at is null
  returning * into v_row;
  if v_row.tour_id is null and p_expected = 0 then
    insert into public.voyz_tours(owner_id, tour_id, document, revision)
    values (v_owner, p_tour_id, p_document, 1)
    on conflict (owner_id, tour_id) do nothing returning * into v_row;
  end if;
  if v_row.tour_id is null then
    raise exception 'REVISION_CONFLICT' using errcode = 'P0001';
  end if;
  return jsonb_build_object('id', v_row.tour_id, 'revision', v_row.revision,
    'updatedAt', v_row.updated_at, 'deletedAt', v_row.deleted_at);
end $$;

create function voyz_private.set_deleted(p_tour_id text, p_expected bigint, p_deleted boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_row public.voyz_tours%rowtype;
begin
  if v_owner is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_expected is null or p_expected < 1 or p_deleted is null then
    raise exception 'INVALID_REVISION' using errcode = '22023';
  end if;
  update public.voyz_tours
  set deleted_at = case when p_deleted then clock_timestamp() else null end,
    revision = revision + 1, updated_at = clock_timestamp()
  where owner_id = v_owner and tour_id = p_tour_id and revision = p_expected
    and ((p_deleted and deleted_at is null) or (not p_deleted and deleted_at is not null))
  returning * into v_row;
  if v_row.tour_id is null then
    raise exception 'REVISION_CONFLICT' using errcode = 'P0001';
  end if;
  -- Restoring a tour does not reactivate previously shared URLs.
  if p_deleted then
    update voyz_private.shares set revoked_at = clock_timestamp()
    where owner_id = v_owner and tour_id = p_tour_id and revoked_at is null;
  end if;
  return jsonb_build_object('id', v_row.tour_id, 'revision', v_row.revision,
    'updatedAt', v_row.updated_at, 'deletedAt', v_row.deleted_at);
end $$;

create function public.voyz_list_tours()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.tour_id, 'revision', t.revision,
    'title', t.document#>>'{tour,title}',
    'startDate', t.document#>>'{tour,startDate}', 'endDate', t.document#>>'{tour,endDate}',
    'dayCount', jsonb_array_length(t.document->'days'),
    'createdAt', t.created_at, 'updatedAt', t.updated_at, 'deletedAt', t.deleted_at
  ) order by t.created_at, t.tour_id), '[]'::jsonb)
  from public.voyz_tours t where t.owner_id = (select auth.uid())
$$;

create function public.voyz_get_tour(p_tour_id text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('id', t.tour_id, 'revision', t.revision,
    'updatedAt', t.updated_at, 'deletedAt', t.deleted_at, 'document', t.document)
  from public.voyz_tours t where t.owner_id = (select auth.uid()) and t.tour_id = p_tour_id
$$;

create function public.voyz_put_tour(p_tour_id text, p_expected bigint, p_document jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select voyz_private.put_tour(p_tour_id, p_expected, p_document)
$$;
create function public.voyz_delete_tour(p_tour_id text, p_expected bigint)
returns jsonb language sql security invoker set search_path = '' as $$
  select voyz_private.set_deleted(p_tour_id, p_expected, true)
$$;
create function public.voyz_restore_tour(p_tour_id text, p_expected bigint)
returns jsonb language sql security invoker set search_path = '' as $$
  select voyz_private.set_deleted(p_tour_id, p_expected, false)
$$;

create function voyz_private.create_share(p_tour_id text, p_expires_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_token text; v_row voyz_private.shares%rowtype;
begin
  if v_owner is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  -- Lock the tour so a concurrent deletion cannot publish an immediately stale link.
  perform 1 from public.voyz_tours where owner_id = v_owner
    and tour_id = p_tour_id and deleted_at is null for update;
  if not found then raise exception 'TOUR_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_expires_at is not null and p_expires_at <= clock_timestamp() then
    raise exception 'INVALID_EXPIRY' using errcode = '22023';
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into voyz_private.shares(owner_id, tour_id, token_hash, expires_at)
  values (v_owner, p_tour_id, sha256(convert_to(v_token, 'UTF8')), p_expires_at)
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'token', v_token, 'expiresAt', v_row.expires_at);
end $$;

create function voyz_private.list_shares(p_tour_id text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'tourId', s.tour_id,
    'createdAt', s.created_at, 'expiresAt', s.expires_at, 'revokedAt', s.revoked_at)
    order by s.created_at desc), '[]'::jsonb)
  from voyz_private.shares s where s.owner_id = (select auth.uid()) and s.tour_id = p_tour_id
$$;
create function voyz_private.revoke_share(p_share_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_row voyz_private.shares%rowtype;
begin
  if v_owner is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  update voyz_private.shares set revoked_at = coalesce(revoked_at, clock_timestamp())
  where id = p_share_id and owner_id = v_owner returning * into v_row;
  if v_row.id is null then raise exception 'SHARE_NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', v_row.id, 'revokedAt', v_row.revoked_at);
end $$;

-- A positive allowlist at every nested level. Do not replace this with doc - 'crm'.
create function voyz_private.route_projection(p_document jsonb)
returns jsonb language sql immutable security invoker set search_path = '' as $$
  select jsonb_build_object('kind', 'voyz-tour', 'version', 2, 'id', p_document->'id',
    'tour', jsonb_build_object('title', p_document#>'{tour,title}',
      'startDate', p_document#>'{tour,startDate}', 'endDate', p_document#>'{tour,endDate}'),
    'days', coalesce((select jsonb_agg(jsonb_build_object(
      'id', d.value->'id', 'title', d.value->>'title', 'description', d.value->>'description',
      'photo', d.value->>'photo', 'photoCredit', d.value->>'photoCredit',
      'noteTitle', d.value->>'noteTitle', 'note', d.value->>'note',
      'planBTitle', d.value->>'planBTitle', 'planB', d.value->>'planB',
      'width', d.value->'width', 'x', d.value->'x', 'y', d.value->'y',
      'lodgingName', d.value->>'lodgingName', 'lodgingUrl', d.value->>'lodgingUrl',
      'schedule', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.value->'id', 'time', e.value->>'time', 'text', e.value->>'text'
      ) order by e.ordinality) from jsonb_array_elements(d.value->'schedule')
        with ordinality as e(value, ordinality)), '[]'::jsonb)
    ) order by d.ordinality) from jsonb_array_elements(p_document->'days')
      with ordinality as d(value, ordinality)), '[]'::jsonb),
    'connections', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.value->'id', 'from', c.value->>'from', 'to', c.value->>'to',
      'fromPort', c.value->>'fromPort', 'toPort', c.value->>'toPort',
      'style', c.value->>'style', 'color', c.value->>'color', 'label', c.value->>'label'
    ) order by c.ordinality) from jsonb_array_elements(
      case when jsonb_typeof(p_document->'connections') = 'array'
        then p_document->'connections' else '[]'::jsonb end
    ) with ordinality as c(value, ordinality)), '[]'::jsonb),
    'view', jsonb_build_object('zoom', p_document#>'{view,zoom}'))
$$;

create function voyz_private.read_share(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select jsonb_build_object('document', voyz_private.route_projection(t.document),
    'revision', t.revision, 'updatedAt', t.updated_at, 'expiresAt', s.expires_at, 'readOnly', true)
  into v_result from voyz_private.shares s
  join public.voyz_tours t on t.owner_id = s.owner_id and t.tour_id = s.tour_id
  where s.token_hash = sha256(convert_to(p_token, 'UTF8'))
    and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
    and t.deleted_at is null;
  return v_result;
end $$;

create function public.voyz_create_share(p_tour_id text, p_expires_at timestamptz default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select voyz_private.create_share(p_tour_id, p_expires_at)
$$;
create function public.voyz_list_shares(p_tour_id text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select voyz_private.list_shares(p_tour_id)
$$;
create function public.voyz_revoke_share(p_share_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select voyz_private.revoke_share(p_share_id)
$$;
create function public.voyz_read_share(p_token text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select voyz_private.read_share(p_token)
$$;

-- Explicit function grants; never revoke unrelated functions in public.
revoke all on function voyz_private.validate_tour(text,jsonb) from public, anon, authenticated;
revoke all on function voyz_private.route_projection(jsonb) from public, anon, authenticated;
revoke all on function voyz_private.put_tour(text,bigint,jsonb) from public, anon, authenticated;
revoke all on function voyz_private.set_deleted(text,bigint,boolean) from public, anon, authenticated;
revoke all on function voyz_private.create_share(text,timestamptz) from public, anon, authenticated;
revoke all on function voyz_private.list_shares(text) from public, anon, authenticated;
revoke all on function voyz_private.revoke_share(uuid) from public, anon, authenticated;
revoke all on function voyz_private.read_share(text) from public, anon, authenticated;
grant execute on function voyz_private.put_tour(text,bigint,jsonb),
  voyz_private.set_deleted(text,bigint,boolean), voyz_private.create_share(text,timestamptz),
  voyz_private.list_shares(text), voyz_private.revoke_share(uuid) to authenticated;
grant execute on function voyz_private.read_share(text) to anon, authenticated;

revoke all on function public.voyz_list_tours() from public, anon, authenticated;
revoke all on function public.voyz_get_tour(text) from public, anon, authenticated;
revoke all on function public.voyz_put_tour(text,bigint,jsonb) from public, anon, authenticated;
revoke all on function public.voyz_delete_tour(text,bigint) from public, anon, authenticated;
revoke all on function public.voyz_restore_tour(text,bigint) from public, anon, authenticated;
revoke all on function public.voyz_create_share(text,timestamptz) from public, anon, authenticated;
revoke all on function public.voyz_list_shares(text) from public, anon, authenticated;
revoke all on function public.voyz_revoke_share(uuid) from public, anon, authenticated;
revoke all on function public.voyz_read_share(text) from public, anon, authenticated;
grant execute on function public.voyz_list_tours(), public.voyz_get_tour(text),
  public.voyz_put_tour(text,bigint,jsonb), public.voyz_delete_tour(text,bigint),
  public.voyz_restore_tour(text,bigint), public.voyz_create_share(text,timestamptz),
  public.voyz_list_shares(text), public.voyz_revoke_share(uuid) to authenticated;
grant execute on function public.voyz_read_share(text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
