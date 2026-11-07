process.on('uncaughtException',e=>{console.error(e.message);process.exit(1)});
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
await db.exec(`
 create role anon;create role authenticated;create role service_role bypassrls;
 create table public.news_items(id uuid primary key,title text,rewritten_title text,source_type text,created_at timestamptz default now(),pub_date timestamptz,published boolean default false,review_status text default 'pending',scheduled_at timestamptz,video_file_id text,telegram_chat_id bigint,graphic_image_url text,original_image_url text,telegram_preview_message_id bigint,updated_at timestamptz);
 create table public.bot_settings(id text primary key,auto_publish boolean,schedule_interval_minutes integer,queue_limit integer);
 create table public.bot_activity(event_type text,item_id uuid,actor text,details jsonb,created_at timestamptz default now());
 insert into public.bot_settings values('main',false,15,2);
 grant select,update on public.news_items,public.bot_settings to service_role;
 grant select,insert on public.bot_activity to service_role;
`);
await db.exec(readFileSync(new URL('../supabase/queue/preview-jobs.sql',import.meta.url),'utf8'));
const ids=[1,2,3,4].map(n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0'));
for(let n=0;n<4;n++)await db.query(`insert into news_items(id,title,rewritten_title,source_type,telegram_chat_id,created_at,pub_date,graphic_image_url,original_image_url,telegram_preview_message_id) values($1,'story','ready','telegram',$2,now()+make_interval(secs=>$3),now()-make_interval(days=>$3::int),'https://example.com/graphic','https://example.com/original',123)`,[ids[n],n===3?999:111,n]);
await db.exec('set role service_role');
for(let n=0;n<3;n++)assert.equal((await db.query('select enqueue_radin_preview($1,111) as ok',[ids[n]])).rows[0].ok,true);
assert.equal((await db.query('select enqueue_radin_preview($1,222) as ok',[ids[0]])).rows[0].ok,false);
let job=(await db.query('select * from claim_radin_preview()')).rows[0];
assert.equal(job.item_id,ids[2]);assert.equal((await db.query('select * from claim_radin_preview()')).rows.length,0);
assert.equal((await db.query('select finish_radin_preview($1,$2,null) as ok',[job.item_id,ids[0]])).rows[0].ok,false);
await db.query('select finish_radin_preview($1,$2,null)',[job.item_id,job.lease_token]);
job=(await db.query('select * from claim_radin_preview()')).rows[0];assert.equal(job.item_id,ids[1]);
// New request during a leased render is not lost.
await db.query('select enqueue_radin_preview($1,111)',[job.item_id]);
await db.query('select finish_radin_preview($1,$2,null)',[job.item_id,job.lease_token]);
assert.equal((await db.query('select state from radin_preview_jobs where item_id=$1',[job.item_id])).rows[0].state,'queued');
job=(await db.query('select * from claim_radin_preview()')).rows[0];
await db.query('select finish_radin_preview($1,$2,$3)',[job.item_id,job.lease_token,'temporary failure']);
assert.equal((await db.query('select * from claim_radin_preview()')).rows[0].item_id,ids[0]);
// Recover a crashed worker after lease expiration.
await db.exec('reset role');await db.exec("update radin_preview_jobs set locked_at=now()-interval '6 minutes' where state='processing'");await db.exec('set role service_role');
job=(await db.query('select * from claim_radin_preview()')).rows[0];assert.equal(job.item_id,ids[0]);assert.equal(job.attempts,2);
await db.query('select finish_radin_preview($1,$2,null)',[job.item_id,job.lease_token]);
assert.equal((await db.query('select fill_radin_publish_queue(array[111]::bigint[]) as n')).rows[0].n,0);
await db.exec("update bot_settings set auto_publish=true where id='main'");
assert.equal((await db.query('select fill_radin_publish_queue(array[111]::bigint[]) as n')).rows[0].n,2);
let scheduled=(await db.query('select id from news_items where scheduled_at is not null order by scheduled_at')).rows;
assert.deepEqual(scheduled.map(x=>x.id),[ids[2],ids[1]]);
assert.equal((await db.query('select fill_radin_publish_queue(array[111]::bigint[]) as n')).rows[0].n,0);
assert.equal((await db.query('select scheduled_at from news_items where id=$1',[ids[3]])).rows[0].scheduled_at,null);
// A newly-ready story takes the first existing slot without delaying it.
const oldTime=(await db.query('select scheduled_at from news_items where id=$1',[ids[2]])).rows[0].scheduled_at;
await db.exec('reset role');
const newest='00000000-0000-0000-0000-000000000005';
await db.query("insert into news_items(id,title,rewritten_title,source_type,telegram_chat_id,created_at,graphic_image_url,original_image_url,telegram_preview_message_id) values($1,'newest','ready','telegram',111,now()+interval '1 hour','https://example.com/g','https://example.com/o',555)",[newest]);
await db.exec('set role service_role');
assert.equal((await db.query('select fill_radin_publish_queue(array[111]::bigint[]) as n')).rows[0].n,1);
scheduled=(await db.query('select id,scheduled_at from news_items where scheduled_at is not null order by scheduled_at')).rows;
assert.deepEqual(scheduled.map(x=>x.id),[newest,ids[2]]);
assert.equal(scheduled[0].scheduled_at.getTime(),oldTime.getTime());
assert.equal((await db.query('select fill_radin_publish_queue(array[111]::bigint[]) as n')).rows[0].n,0);
// Near-due stories keep their place while newer news takes the next slot.
await db.exec('reset role');
await db.query("update news_items set scheduled_at=now()+interval '1 minute' where id=$1",[newest]);
const next='00000000-0000-0000-0000-000000000006';
await db.query("insert into news_items(id,title,rewritten_title,source_type,telegram_chat_id,created_at,graphic_image_url,original_image_url,telegram_preview_message_id) values($1,'next','ready','telegram',111,now()+interval '2 hours','https://example.com/g','https://example.com/o',666)",[next]);
await db.exec('set role service_role');
assert.equal((await db.query('select fill_radin_publish_queue(array[111]::bigint[]) as n')).rows[0].n,1);
assert.deepEqual((await db.query('select id from news_items where scheduled_at is not null order by scheduled_at')).rows.map(x=>x.id),[newest,next]);
// A permanently failing render stops after three attempts instead of blocking.
await db.exec("update radin_preview_jobs set state='complete',lease_token=null,locked_at=null");
await db.query('select enqueue_radin_preview($1,111)',[ids[0]]);
for(let attempt=1;attempt<=3;attempt++){
 const failedJob=(await db.query('select * from claim_radin_preview()')).rows[0];
 assert.equal(failedJob.attempts,attempt);
 await db.query('select finish_radin_preview($1,$2,$3)',[failedJob.item_id,failedJob.lease_token,'render failed']);
 await db.exec("update radin_preview_jobs set available_at=now() where state='queued'");
}
assert.equal((await db.query('select state from radin_preview_jobs where item_id=$1',[ids[0]])).rows[0].state,'failed');
assert.equal((await db.query('select * from claim_radin_preview()')).rows.length,0);
await db.exec('reset role;set role anon');
await assert.rejects(db.query('select * from claim_radin_preview()'),/permission denied/);
await assert.rejects(db.query('select * from radin_preview_jobs'),/permission denied/);
console.log('PASS: burst queue, exclusive claim, latest-first order, lease recovery, stale completion, retry, fresh request preservation, auto-off, queue cap, admin-only scheduling, anonymous denial');
await db.close();
