import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/radin-telegram-webhook/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,''));
const itemId='2d36a95f-9570-468e-bd5b-58e742412912';
async function run({fail=false,timeout=false,callback=false,regenerate=false,forward=false,toggle=false,queueView=false}={}){
 let handler;const calls=[],activity=[],updates=[];
 const rpcCalls=[],background=[];
 const db={async rpc(name,args){rpcCalls.push({name,args});return {data:name==="enqueue_radin_preview"?!fail:2,error:null};},from(table){return {update(data){updates.push(data);const q={eq(){return this;},then(resolve){resolve({error:null});}};return q;},insert(data){activity.push(data);return {select:()=>({single:async()=>({data:{id:itemId},error:null})}),then(resolve){resolve({error:null});}};},select(){const q={eq(){return this;},gte(){return this;},in(){return this;},is(){return this;},not(){return this;},neq(){return this;},order(){return this;},limit(){return this;},then(resolve){resolve({data:table==='radin_preview_jobs'?[{item_id:itemId,state:'processing',news_items:{title:'خبر تازه'}}]:[],error:null,count:0});},async maybeSingle(){return {data:table==='bot_settings'?{auto_publish:false,schedule_interval_minutes:15,queue_limit:5}:table==='news_items'&&!forward?{id:itemId,published:false,review_status:'pending',telegram_chat_id:9129058355,graphic_quality_status:'review',graphic_image_url:'https://images.example/preview.png'}:null,error:null};}};return q;}};}};
 vm.runInNewContext(source,{Deno:{env:{get:k=>({BOT_TOKEN:'test-bot',TELEGRAM_WEBHOOK_SECRET:'webhook-secret',SUPABASE_URL:'https://project.example',SUPABASE_SERVICE_ROLE_KEY:'server-key',SUPABASE_ANON_KEY:'anon-key'})[k]},serve:fn=>{handler=fn;}},EdgeRuntime:{waitUntil:p=>background.push(p)},createClient:()=>db,fetch:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,headers:options.headers,body});
  if(url.includes('/functions/v1/radin-preview-queue')){if(timeout)throw new Error('wake-up timeout');return new Response('{}',{status:202});}
  if(url.includes('/functions/v1/radin-graphic-worker')){
   if(timeout)throw new Error('timed out');
   return new Response(JSON.stringify(fail?{error:'Unauthorized'}:{results:[{id:itemId,ok:true,preview_sent:true}]}),{status:fail?401:200});
  }
  return new Response(JSON.stringify({ok:true,result:{message_id:123}}));
 },Request,Response,URL,AbortSignal,TextEncoder,Uint8Array,Intl,console});
 const response=await handler(new Request('https://project.example/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'webhook-secret','content-type':'application/json'},body:JSON.stringify(forward?{message:{message_id:7,date:1794070000,from:{id:9129058355},chat:{id:9129058355,type:'private'},forward_origin:{type:'hidden_user',sender_user_name:'Test source'},text:'خبر جدید از ایران اعلام شد\nاین گزارش برای بررسی خبر در کشور است.'}}:{callback_query:{id:'callback1',from:{id:9129058355},data:toggle?'botsettings:auto':queueView?'botqueue:refresh':regenerate?'regenerate:'+itemId:(callback?'designposter:':'processnews:')+itemId+(callback?'':':none'),message:{message_id:5,chat:{id:9129058355,type:'private'}}}})}));
 await Promise.allSettled(background);return {response,calls,activity,updates,rpcCalls};
}
test('language choice durably enqueues and wakes a background processor',async()=>{
 const s=await run();assert.equal(s.response.status,200);
 const call=s.calls.find(x=>x.url.includes('/radin-preview-queue'));
 assert.equal(call.headers.authorization,'Bearer server-key');
 assert.equal(call.headers['x-radin-telegram-secret'],'webhook-secret');
 assert.equal(s.rpcCalls[0].name,'enqueue_radin_preview');assert.equal(s.rpcCalls[0].args.p_item_id,itemId);
 assert.equal(s.calls.some(x=>x.url.includes('/radin-publish-news')),false);
});
test('failed processing and timeout restore an actionable retry button',async()=>{
 for(const config of [{fail:true},{fail:true,callback:true}]){
  const s=await run(config);
  const message=s.calls.find(x=>x.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==='designposter:'+itemId);
  assert.ok(message);assert.equal(message.body.chat_id,9129058355);
  assert.ok(s.rpcCalls.some(x=>x.name==='enqueue_radin_preview'));
 }
});
test('regeneration delivers edit and publish actions using valid Telegram markup',async()=>{
 const s=await run({regenerate:true});
 const preview=s.calls.find(x=>x.url.endsWith('/editMessageMedia'));
 assert.ok(preview);
 assert.ok(Array.isArray(preview.body.reply_markup.inline_keyboard));
 assert.ok(preview.body.reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='publish:'+itemId));
 assert.ok(preview.body.reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='edit:headline:'+itemId));
});

test('a Persian forwarded story is saved pending and starts an actionable preview',async()=>{
 const s=await run({forward:true});
 assert.equal(s.response.status,200);
 const story=s.activity.find(x=>x.source_type==='telegram');
 assert.ok(story);assert.equal(story.review_status,'pending');assert.equal(story.published,false);
 assert.ok(s.rpcCalls.some(x=>x.name==='enqueue_radin_preview'&&x.args.p_item_id===itemId));
 assert.equal(s.calls.some(x=>x.url.endsWith('/radin-publish-news')),false);
});

test('a lost wake-up leaves the durable job queued for cron',async()=>{
 const s=await run({timeout:true});assert.equal(s.response.status,200);
 assert.ok(s.rpcCalls.some(x=>x.name==='enqueue_radin_preview'));
});

test('enabling auto queue fills ready news and immediately displays the queue',async()=>{
 const s=await run({toggle:true});
 assert.ok(s.updates.some(x=>x.auto_publish===true));
 assert.ok(s.rpcCalls.some(x=>x.name==='fill_radin_publish_queue'));
 assert.ok(s.calls.some(x=>x.body.text?.includes('صف ارسال زمان‌بندی‌شده')));
});
test('queue view includes stories still being processed',async()=>{
 const s=await run({queueView:true});
 assert.ok(s.calls.some(x=>x.body.text?.includes('در حال ساخت — خبر تازه')));
});
