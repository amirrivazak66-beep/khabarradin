-- Durable processing jobs, separate from the publication schedule.
create index if not exists bot_activity_received_order on public.bot_activity(item_id,created_at desc) where event_type='received';
create table public.radin_preview_jobs (
  item_id uuid primary key references public.news_items(id) on delete cascade,
  chat_id bigint not null,
  state text not null default 'queued' check (state in ('queued','processing','complete','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  requested_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  lease_token uuid,
  last_error text,
  updated_at timestamptz not null default now()
);
create index radin_preview_jobs_available on public.radin_preview_jobs(available_at,requested_at desc) where state='queued';
alter table public.radin_preview_jobs enable row level security;
revoke all on public.radin_preview_jobs from public,anon,authenticated;
grant select,insert,update,delete on public.radin_preview_jobs to service_role;
create policy "Preview jobs service role only" on public.radin_preview_jobs for all to service_role using (true) with check (true);

create function public.enqueue_radin_preview(p_item_id uuid,p_chat_id bigint)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.news_items where id=p_item_id and published=false and review_status<>'rejected' and telegram_chat_id=p_chat_id) then return false; end if;
  insert into public.radin_preview_jobs(item_id,chat_id) values(p_item_id,p_chat_id)
  on conflict(item_id) do update set
    state=case when radin_preview_jobs.state='processing' then 'processing' else 'queued' end,
    attempts=case when radin_preview_jobs.state='processing' then radin_preview_jobs.attempts else 0 end,
    requested_at=clock_timestamp(),available_at=now(),last_error=null,updated_at=now();
  return true;
end;
$$;

create function public.claim_radin_preview()
returns setof public.radin_preview_jobs language plpgsql security invoker set search_path='' as $$
begin
  -- One renderer at a time across every Edge Function instance.
  perform pg_catalog.pg_advisory_xact_lock(728194206);
  update public.radin_preview_jobs set state=case when attempts>=3 then 'failed' else 'queued' end,
    available_at=now(),locked_at=null,lease_token=null,last_error='Processing lease expired',updated_at=now()
    where state='processing' and locked_at<now()-interval '5 minutes';
  if exists(select 1 from public.radin_preview_jobs where state='processing') then return; end if;
  -- Remove jobs for news that was rejected/deleted/published while waiting.
  update public.radin_preview_jobs j set state='complete',updated_at=now()
    where j.state='queued' and not exists(select 1 from public.news_items n where n.id=j.item_id and not n.published and n.review_status<>'rejected');
  return query update public.radin_preview_jobs set state='processing',attempts=attempts+1,
    locked_at=clock_timestamp(),lease_token=gen_random_uuid(),updated_at=now()
    where item_id=(select item_id from public.radin_preview_jobs where state='queued' and available_at<=now()
      order by requested_at desc,item_id desc limit 1 for update skip locked)
    returning *;
end;
$$;

create function public.finish_radin_preview(p_item_id uuid,p_lease uuid,p_error text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  update public.radin_preview_jobs set
    state=case when requested_at>locked_at then 'queued' when p_error is null then 'complete' when attempts<3 then 'queued' else 'failed' end,
    attempts=case when requested_at>locked_at then 0 else attempts end,
    available_at=case when p_error is null or requested_at>locked_at then now() else now()+interval '1 minute' end,
    last_error=left(p_error,500),locked_at=null,lease_token=null,updated_at=now()
    where item_id=p_item_id and state='processing' and lease_token=p_lease;
  get diagnostics changed=row_count;
  return changed=1;
end;
$$;

-- Atomically fill available publication slots, only for administrator chats.
create function public.fill_radin_publish_queue(p_admin_chat_ids bigint[])
returns integer language plpgsql security invoker set search_path='' as $$
declare settings public.bot_settings%rowtype; slots integer; scheduled_count integer:=0;
  cursor_time timestamptz; item record; step_minutes integer; position integer:=0;
  old_slots timestamptz[]; selected_ids uuid[]:='{}'; next_time timestamptz;
  protected_before timestamptz:=now()+interval '2 minutes';
begin
  perform pg_catalog.pg_advisory_xact_lock(728194207);
  select * into settings from public.bot_settings where id='main' for update;
  if not found or settings.auto_publish is not true then return 0; end if;
  step_minutes:=greatest(5,least(coalesce(settings.schedule_interval_minutes,60),1440));
  -- Freeze near-due/publishing stories. Reuse future time slots so refills do
  -- not keep postponing publication, while newest receipts take the first slot.
  perform 1 from public.news_items where not published and review_status='approved'
    and scheduled_at>protected_before and source_type in ('telegram','website')
    and telegram_chat_id=any(p_admin_chat_ids) for update;
  select array_agg(scheduled_at order by scheduled_at,id) into old_slots from public.news_items
    where not published and review_status='approved' and scheduled_at>protected_before
      and source_type in ('telegram','website') and telegram_chat_id=any(p_admin_chat_ids);
  select greatest(0,least(coalesce(settings.queue_limit,10),50)-count(*)),greatest(now(),coalesce(max(scheduled_at),now()))
    into slots,cursor_time from public.news_items
    where not published and scheduled_at is not null and review_status in ('approved','publishing')
      and not (review_status='approved' and scheduled_at>protected_before
        and source_type in ('telegram','website') and telegram_chat_id=any(p_admin_chat_ids));
  for item in select id,coalesce(nullif(rewritten_title,''),title) as title,scheduled_at from public.news_items
    where not published and video_file_id is null and source_type in ('telegram','website')
      and telegram_chat_id=any(p_admin_chat_ids)
      and ((review_status='pending' and scheduled_at is null) or (review_status='approved' and scheduled_at>protected_before))
      and graphic_image_url~'^https?://' and original_image_url~'^https?://'
      and telegram_preview_message_id is not null
      and (source_type<>'telegram' or length(trim(coalesce(rewritten_title,'')))>0)
    order by coalesce((select max(a.created_at) from public.bot_activity a where a.item_id=news_items.id and a.event_type='received'),created_at) desc,id desc limit slots for update skip locked
  loop
    position:=position+1;
    next_time:=case when old_slots[position]>cursor_time then old_slots[position] else cursor_time+make_interval(mins=>step_minutes) end;
    cursor_time:=next_time;
    selected_ids:=array_append(selected_ids,item.id);
    if item.scheduled_at is distinct from next_time then
      update public.news_items set scheduled_at=next_time,review_status='approved',updated_at=now() where id=item.id;
      if item.scheduled_at is null then
        insert into public.bot_activity(event_type,item_id,actor,details) values('scheduled',item.id,'bot_queue',jsonb_build_object('title',item.title,'scheduled_at',next_time,'source','bot_queue'));
        scheduled_count:=scheduled_count+1;
      end if;
    end if;
  end loop;
  -- Older stories stay available for a later refill when the configured queue
  -- capacity is full; they are not deleted, published, or rejected.
  update public.news_items set scheduled_at=null,review_status='pending',updated_at=now()
    where not published and review_status='approved' and scheduled_at>protected_before
      and source_type in ('telegram','website') and telegram_chat_id=any(p_admin_chat_ids)
      and not (id=any(selected_ids));
  return scheduled_count;
end;
$$;

revoke all on function public.enqueue_radin_preview(uuid,bigint),public.claim_radin_preview(),public.finish_radin_preview(uuid,uuid,text),public.fill_radin_publish_queue(bigint[]) from public,anon,authenticated;
grant execute on function public.enqueue_radin_preview(uuid,bigint),public.claim_radin_preview(),public.finish_radin_preview(uuid,uuid,text),public.fill_radin_publish_queue(bigint[]) to service_role;
