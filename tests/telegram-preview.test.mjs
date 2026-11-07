import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/radin-telegram-webhook/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,''));
const itemId='2d36a95f-9570-468e-bd5b-58e742412912';
async function run({fail=false,timeout=false,callback=false,regenerate=false,forward=false}={}){
 let handler;const calls=[],activity=[],updates=[];
 const db={from(table){return {update(data){updates.push(data);const q={eq(){return this;},then(resolve){resolve({error:null});}};return q;},insert(data){activity.push(data);return {select:()=>({single:async()=>({data:{id:itemId},error:null})}),then(resolve){resolve({error:null});}};},select(){const q={eq(){return this;},gte(){return this;},order(){return this;},limit(){return this;},then(resolve){resolve({data:[],error:null});},async maybeSingle(){return {data:table==='news_items'&&!forward?{id:itemId,published:false,review_status:'pending',telegram_chat_id:9129058355,graphic_quality_status:'review',graphic_image_url:'https://images.example/preview.png'}:null,error:null};}};return q;}};}};
 vm.runInNewContext(source,{Deno:{env:{get:k=>({BOT_TOKEN:'test-bot',TELEGRAM_WEBHOOK_SECRET:'webhook-secret',SUPABASE_URL:'https://project.example',SUPABASE_SERVICE_ROLE_KEY:'server-key',SUPABASE_ANON_KEY:'anon-key'})[k]},serve:fn=>{handler=fn;}},createClient:()=>db,fetch:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,headers:options.headers,body});
  if(url.includes('/functions/v1/radin-graphic-worker')){
   if(timeout)throw new Error('timed out');
   return new Response(JSON.stringify(fail?{error:'Unauthorized'}:{results:[{id:itemId,ok:true,preview_sent:true}]}),{status:fail?401:200});
  }
  return new Response(JSON.stringify({ok:true,result:{message_id:123}}));
 },Request,Response,URL,AbortSignal,TextEncoder,Uint8Array,Intl,console});
 const response=await handler(new Request('https://project.example/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'webhook-secret','content-type':'application/json'},body:JSON.stringify(forward?{message:{message_id:7,date:1794070000,from:{id:9129058355},chat:{id:9129058355,type:'private'},forward_origin:{type:'hidden_user',sender_user_name:'Test source'},text:'خبر جدید از ایران اعلام شد\nاین گزارش برای بررسی خبر در کشور است.'}}:{callback_query:{id:'callback1',from:{id:9129058355},data:regenerate?'regenerate:'+itemId:(callback?'designposter:':'processnews:')+itemId+(callback?'':':none'),message:{message_id:5,chat:{id:9129058355,type:'private'}}}})}));
 return {response,calls,activity,updates};
}
test('language choice calls worker with both server credentials and scheduled preview',async()=>{
 const s=await run();assert.equal(s.response.status,200);
 const call=s.calls.find(x=>x.url.includes('/radin-graphic-worker'));
 assert.equal(call.headers.authorization,'Bearer server-key');
 assert.equal(call.headers['x-radin-telegram-secret'],'webhook-secret');
 assert.equal(call.body.item_id,itemId);assert.equal(call.body.trigger,'scheduled');
 assert.equal(s.calls.some(x=>x.url.includes('/radin-publish-news')),false);
});
test('failed processing and timeout restore an actionable retry button',async()=>{
 for(const config of [{fail:true},{timeout:true},{fail:true,callback:true}]){
  const s=await run(config);
  const message=s.calls.find(x=>x.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==='designposter:'+itemId);
  assert.ok(message);assert.equal(message.body.chat_id,9129058355);
  assert.ok(s.activity.some(x=>x.event_type==='graphic_failed'));
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
 assert.ok(s.calls.some(x=>x.url.endsWith('/radin-graphic-worker')&&x.body.item_id===itemId));
 assert.equal(s.calls.some(x=>x.url.endsWith('/radin-publish-news')),false);
});
