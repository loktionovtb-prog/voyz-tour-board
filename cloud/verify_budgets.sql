begin;
select set_config('request.jwt.claim.sub',(select id::text from auth.users limit 1),true);
set local role authenticated;
do $$
declare v_id uuid:=gen_random_uuid(); v_doc jsonb; v jsonb; c integer;
begin
  v_doc:=jsonb_build_object('id',v_id,'version',1,'title','__budget_rollback_test');
  v:=public.voyz_save_budget(v_id,0,v_doc);if (v->>'revision')::int<>1 then raise exception 'first save failed';end if;
  v:=public.voyz_save_budget(v_id,1,v_doc);if (v->>'revision')::int<>2 then raise exception 'second save failed';end if;
  select count(*) into c from public.voyz_budget_versions where budget_id=v_id;if c<>2 then raise exception 'history failed';end if;
  begin perform public.voyz_save_budget(v_id,1,v_doc);raise exception 'stale update accepted';exception when raise_exception then if sqlerrm<>'REVISION_CONFLICT' then raise;end if;end;
  begin perform public.voyz_save_budget(v_id,0,v_doc);raise exception 'duplicate accepted';exception when raise_exception then if sqlerrm<>'REVISION_CONFLICT' then raise;end if;end;
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  select count(*) into c from public.voyz_budgets where id=v_id;if c<>0 then raise exception 'cross-owner read';end if;
  select count(*) into c from public.voyz_budget_versions where budget_id=v_id;if c<>0 then raise exception 'cross-owner history read';end if;
  begin perform public.voyz_save_budget(v_id,2,v_doc);raise exception 'cross-owner write';exception when raise_exception then if sqlerrm<>'REVISION_CONFLICT' then raise;end if;end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform * from public.voyz_budgets;raise exception 'anonymous read accepted';exception when insufficient_privilege then null;end;
  begin perform * from public.voyz_budget_versions;raise exception 'anonymous history accepted';exception when insufficient_privilege then null;end;
  begin perform public.voyz_save_budget(gen_random_uuid(),0,'{}');raise exception 'anonymous write accepted';exception when insufficient_privilege then null;end;
end $$;
reset role;
select 'PASS: owner create/update/history, stale revision, cross-owner isolation, anonymous denied; transaction rolled back' as result;
rollback;
