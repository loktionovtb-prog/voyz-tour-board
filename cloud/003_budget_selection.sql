begin;
create table public.voyz_budget_choices (
 owner_id uuid not null default auth.uid() references auth.users(id),
 project_id text not null check(length(project_id) between 1 and 100),
 budget_id uuid not null,
 primary key(owner_id,project_id),
 foreign key(owner_id,budget_id) references public.voyz_budgets(owner_id,id)
);
alter table public.voyz_budget_choices enable row level security;
revoke all on public.voyz_budget_choices from public,anon,authenticated;
grant select,insert,update,delete on public.voyz_budget_choices to authenticated;
create policy choices_owner on public.voyz_budget_choices for all to authenticated using ((select auth.uid())=owner_id) with check ((select auth.uid())=owner_id);
create function public.voyz_choose_budget(p_project_id text,p_budget_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'AUTH_REQUIRED';end if;
 if p_budget_id is null then delete from public.voyz_budget_choices where owner_id=auth.uid() and project_id=p_project_id;return;end if;
 if not exists(select 1 from public.voyz_budgets where owner_id=auth.uid() and id=p_budget_id and coalesce(document->>'projectId','unassigned')=p_project_id) then raise exception 'BUDGET_PROJECT_MISMATCH';end if;
 insert into public.voyz_budget_choices(owner_id,project_id,budget_id) values(auth.uid(),p_project_id,p_budget_id)
 on conflict(owner_id,project_id) do update set budget_id=excluded.budget_id;
end $$;
revoke all on function public.voyz_choose_budget(text,uuid) from public,anon;
grant execute on function public.voyz_choose_budget(text,uuid) to authenticated;
commit;
