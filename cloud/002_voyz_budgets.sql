begin;
create table public.voyz_budgets (
  owner_id uuid not null default auth.uid() references auth.users(id),
  id uuid not null,
  revision bigint not null default 1 check(revision>0),
  document jsonb not null check(jsonb_typeof(document)='object' and document->>'version'='1' and document->>'id'=id::text and octet_length(document::text)<=2000000),
  updated_at timestamptz not null default now(),
  primary key(owner_id,id)
);
create table public.voyz_budget_versions (
  owner_id uuid not null references auth.users(id),
  budget_id uuid not null,
  revision bigint not null,
  document jsonb not null,
  saved_at timestamptz not null default now(),
  primary key(owner_id,budget_id,revision),
  foreign key(owner_id,budget_id) references public.voyz_budgets(owner_id,id)
);
alter table public.voyz_budgets enable row level security;
alter table public.voyz_budget_versions enable row level security;
revoke all on public.voyz_budgets,public.voyz_budget_versions from public,anon,authenticated;
grant select,insert,update on public.voyz_budgets to authenticated;
grant select,insert on public.voyz_budget_versions to authenticated;
create policy budget_select on public.voyz_budgets for select to authenticated using ((select auth.uid())=owner_id);
create policy budget_insert on public.voyz_budgets for insert to authenticated with check ((select auth.uid())=owner_id);
create policy budget_update on public.voyz_budgets for update to authenticated using ((select auth.uid())=owner_id) with check ((select auth.uid())=owner_id);
create policy version_select on public.voyz_budget_versions for select to authenticated using ((select auth.uid())=owner_id);
create policy version_insert on public.voyz_budget_versions for insert to authenticated with check ((select auth.uid())=owner_id);
create function public.voyz_save_budget(p_id uuid,p_expected bigint,p_document jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_revision bigint; v_time timestamptz;
begin
  if v_owner is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_expected is null or p_expected<0 or p_document is null or p_document->>'id' is distinct from p_id::text then raise exception 'INVALID_BUDGET'; end if;
  if p_expected=0 then
    insert into public.voyz_budgets(owner_id,id,revision,document) values(v_owner,p_id,1,p_document)
      on conflict(owner_id,id) do nothing returning revision,updated_at into v_revision,v_time;
  else
    update public.voyz_budgets set document=p_document,revision=revision+1,updated_at=now()
      where owner_id=v_owner and id=p_id and revision=p_expected returning revision,updated_at into v_revision,v_time;
  end if;
  if v_revision is null then raise exception 'REVISION_CONFLICT'; end if;
  insert into public.voyz_budget_versions(owner_id,budget_id,revision,document) values(v_owner,p_id,v_revision,p_document);
  return jsonb_build_object('revision',v_revision,'updated_at',v_time);
end; $$;
revoke all on function public.voyz_save_budget(uuid,bigint,jsonb) from public,anon;
grant execute on function public.voyz_save_budget(uuid,bigint,jsonb) to authenticated;
commit;
