-- Run after 001_voyz_cloud.sql in a Supabase project as postgres.
-- No pgTAP dependency. Any exception is a failed assertion. All changes roll back.
-- Passed on Voyz project mjlpcvqrwbtmabivgxuj (PostgreSQL 17.11), 2026-10-03.
begin;

select set_config('voyz.test_owner', gen_random_uuid()::text, true);
select set_config('voyz.test_other', gen_random_uuid()::text, true);
insert into auth.users(id, email) values
  (current_setting('voyz.test_owner')::uuid,
    'voyz-test-' || current_setting('voyz.test_owner') || '@example.invalid'),
  (current_setting('voyz.test_other')::uuid,
    'voyz-test-' || current_setting('voyz.test_other') || '@example.invalid');

select set_config('voyz.test_doc', jsonb_build_object(
  'kind','voyz-tour','version',2,'id','cloud-test-tour',
  'tour',jsonb_build_object('title','Test route','startDate','','endDate',''),
  'ownerSecret','PRIVATE_TOP_LEVEL',
  'days',jsonb_build_array(jsonb_build_object(
    'id','day-one','title','Test day','description','Route description',
    'photo','','photoCredit','','note','Public route note','noteTitle','Notes',
    'planB','','planBTitle','Notes 2','width',600,'x',30,'y',20,
    'lodgingName','Test hotel','lodgingUrl','https://example.com/hotel',
    'futurePrivateField','PRIVATE_DAY_FIELD',
    'schedule',jsonb_build_array(jsonb_build_object('id','event-one',
      'time','10:00','text','Depart','futurePrivateField','PRIVATE_EVENT_FIELD')))),
  'connections','[]'::jsonb,'view',jsonb_build_object('zoom',1),
  'crm',jsonb_build_object('price',100,'currency','USD',
    'clients',jsonb_build_array(jsonb_build_object('id','client-one',
      'name','PRIVATE_CLIENT_NAME','phone','PRIVATE_PHONE','gender','female',
      'departureCity','PRIVATE_CITY','note','','status','confirmed',
      'price',100,'deposit',20,'payment',30))))::text, true);

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('voyz.test_owner'), 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare r jsonb; doc jsonb := current_setting('voyz.test_doc')::jsonb;
begin
  if public.voyz_list_tours() <> '[]'::jsonb then raise exception 'FAIL: empty owner list'; end if;
  r := public.voyz_put_tour('cloud-test-tour',0,doc);
  if (r->>'revision')::bigint <> 1 then raise exception 'FAIL: initial revision'; end if;
  if jsonb_array_length(public.voyz_list_tours()) <> 1 then raise exception 'FAIL: list count'; end if;
  if public.voyz_get_tour('cloud-test-tour')->'document' <> doc then raise exception 'FAIL: lossless document'; end if;

  begin
    perform public.voyz_put_tour('cloud-test-tour',0,doc);
    raise exception 'FAIL: create overwrote existing tour';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'REVISION_CONFLICT' then raise; end if;
  end;

  begin
    update public.voyz_tours set revision = 999 where tour_id = 'cloud-test-tour';
    raise exception 'FAIL: direct write allowed';
  exception when insufficient_privilege then null;
  end;

  r := public.voyz_create_share('cloud-test-tour',null);
  if length(r->>'token') <> 64 then raise exception 'FAIL: share token'; end if;
  perform set_config('voyz.test_share_id',r->>'id',true);
  perform set_config('voyz.test_token',r->>'token',true);
  if public.voyz_list_shares('cloud-test-tour')::text like '%token%' then
    raise exception 'FAIL: token leaked into list';
  end if;

  r := public.voyz_put_tour('cloud-test-tour',1,
    jsonb_set(doc,'{tour,title}','"Updated live route"'::jsonb));
  if (r->>'revision')::bigint <> 2 then raise exception 'FAIL: update revision'; end if;
  begin
    perform public.voyz_delete_tour('cloud-test-tour',1);
    raise exception 'FAIL: stale deletion succeeded';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'REVISION_CONFLICT' then raise; end if;
  end;
end $$;

reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('voyz.test_other'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare r jsonb;
begin
  if public.voyz_list_tours() <> '[]'::jsonb then raise exception 'FAIL: other owner sees list'; end if;
  if public.voyz_get_tour('cloud-test-tour') is not null then raise exception 'FAIL: other owner reads document'; end if;
  if exists (select 1 from public.voyz_tours) then raise exception 'FAIL: RLS direct read'; end if;
  begin
    perform public.voyz_delete_tour('cloud-test-tour',2);
    raise exception 'FAIL: other owner deletes document';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'REVISION_CONFLICT' then raise; end if;
  end;
  begin
    perform public.voyz_revoke_share(current_setting('voyz.test_share_id')::uuid);
    raise exception 'FAIL: other owner revokes share';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'SHARE_NOT_FOUND' then raise; end if;
  end;
  begin
    perform public.voyz_create_share('cloud-test-tour',null);
    raise exception 'FAIL: other owner published first owner route';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'TOUR_NOT_FOUND' then raise; end if;
  end;
  -- Identical tour IDs in different accounts must remain independent.
  r := public.voyz_put_tour('cloud-test-tour',0,
    jsonb_set(current_setting('voyz.test_doc')::jsonb,'{tour,title}','"Second owner route"'::jsonb));
  if (r->>'revision')::bigint <> 1
    or public.voyz_get_tour('cloud-test-tour')#>>'{document,tour,title}' <> 'Second owner route' then
    raise exception 'FAIL: per-owner primary key isolation';
  end if;
end $$;

reset role;
select set_config('request.jwt.claims','{"role":"anon"}',true);
set local role anon;
do $$
declare r jsonb;
begin
  begin
    perform public.voyz_list_tours();
    raise exception 'FAIL: anonymous list permitted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.voyz_tours;
    raise exception 'FAIL: anonymous table read permitted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from voyz_private.shares;
    raise exception 'FAIL: anonymous share listing permitted';
  exception when insufficient_privilege then null;
  end;
  r := public.voyz_read_share(current_setting('voyz.test_token'));
  if r is null or r#>>'{document,tour,title}' <> 'Updated live route'
    or (r->>'revision')::bigint <> 2 then raise exception 'FAIL: live shared route'; end if;
  if r->'document' ? 'crm' or r::text like '%PRIVATE_%' then
    raise exception 'FAIL: private fields leaked through share';
  end if;
  if r#>>'{document,days,0,lodgingName}' <> 'Test hotel'
    or (r#>>'{document,days,0,width}')::integer <> 600 then
    raise exception 'FAIL: lodging or width lost';
  end if;
  if public.voyz_read_share('bad-token') is not null
    or public.voyz_read_share(repeat('0',64)) is not null then
    raise exception 'FAIL: invalid token read';
  end if;
end $$;

reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('voyz.test_owner'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare r jsonb;
begin
  perform public.voyz_revoke_share(current_setting('voyz.test_share_id')::uuid);
  if public.voyz_read_share(current_setting('voyz.test_token')) is not null then
    raise exception 'FAIL: revoked token remains readable';
  end if;
  r := public.voyz_create_share('cloud-test-tour',null);
  perform set_config('voyz.test_token',r->>'token',true);
  r := public.voyz_delete_tour('cloud-test-tour',2);
  if (r->>'revision')::bigint <> 3 or r->>'deletedAt' is null then
    raise exception 'FAIL: deletion revision/tombstone';
  end if;
  if public.voyz_list_tours()->0->>'deletedAt' is null then
    raise exception 'FAIL: tombstone missing from list';
  end if;
  if public.voyz_get_tour('cloud-test-tour')->'document' is null then
    raise exception 'FAIL: soft deletion removed recovery document';
  end if;
  begin
    perform public.voyz_put_tour('cloud-test-tour',3,current_setting('voyz.test_doc')::jsonb);
    raise exception 'FAIL: ordinary save resurrected tombstone';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'REVISION_CONFLICT' then raise; end if;
  end;
  if public.voyz_read_share(current_setting('voyz.test_token')) is not null then
    raise exception 'FAIL: deleted route remains readable';
  end if;
  r := public.voyz_restore_tour('cloud-test-tour',3);
  if (r->>'revision')::bigint <> 4 or r->>'deletedAt' is not null then
    raise exception 'FAIL: restore revision';
  end if;
  if public.voyz_read_share(current_setting('voyz.test_token')) is not null then
    raise exception 'FAIL: restore reactivated old share';
  end if;
  begin
    perform public.voyz_create_share('cloud-test-tour',now() - interval '1 day');
    raise exception 'FAIL: past expiry accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'INVALID_EXPIRY' then raise; end if;
  end;
  begin
    perform public.voyz_put_tour('cloud-test-tour',4,
      jsonb_set(current_setting('voyz.test_doc')::jsonb,'{days,0,width}',
        '{"crm":"PRIVATE_NESTED_OBJECT"}'::jsonb));
    raise exception 'FAIL: object accepted as width';
  exception when invalid_parameter_value then
    if sqlerrm <> 'INVALID_DOCUMENT' then raise; end if;
  end;
  r := public.voyz_create_share('cloud-test-tour',now() + interval '1 day');
  perform set_config('voyz.test_expiring_share',r->>'id',true);
  perform set_config('voyz.test_expiring_token',r->>'token',true);
end $$;

reset role;
-- Set an expired timestamp without waiting; this test change is rolled back.
update voyz_private.shares set expires_at = now() - interval '1 day'
where id = current_setting('voyz.test_expiring_share')::uuid;
select set_config('request.jwt.claims','{"role":"anon"}',true);
set local role anon;
do $$
begin
  if public.voyz_read_share(current_setting('voyz.test_expiring_token')) is not null then
    raise exception 'FAIL: expired share remains readable';
  end if;
  begin
    perform public.voyz_put_tour('cloud-test-tour',0,current_setting('voyz.test_doc')::jsonb);
    raise exception 'FAIL: anonymous RPC write permitted';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;
-- Expected result: no assertion exception, final ROLLBACK successful.
