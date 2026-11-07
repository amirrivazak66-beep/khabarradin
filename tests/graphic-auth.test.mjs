import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/radin-graphic-worker/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,''));
const itemId='2d36a95f-9570-468e-bd5b-58e742412912';
async function invoke({bearer='',secret='',body={item_id:itemId},aal='aal1',allowed=false,cron=false,items=[]}={}) {
 let handler, queried=false;const telegramCalls=[];
 const db={async rpc(){return {data:cron,error:null};},auth:{async getUser(){return {data:{user:{email:'admin@example.com',email_confirmed_at:'2026-01-01'}},error:null};}},from(table){
   if(table==='web_admin_emails')return {select:()=>({eq:()=>({eq:()=>({maybeSingle:async()=>({data:allowed?{email:'admin@example.com'}:null,error:null})})})})};
   if(table==='telegram_trial_accounts')return {select:()=>({eq:()=>({maybeSingle:async()=>({data:null,error:null})})})};
   assert.equal(table,'news_items'); queried=true;
   const query={eq(){return this;},neq(){return this;},or(){return this;},order(){return this;},limit(){return this;},then(resolve){resolve({data:items,error:null});}};
   return {select:()=>query,update:()=>({eq:async()=>({error:null})})};
 }};
 vm.runInNewContext(source,{Deno:{env:{get:k=>({BOT_TOKEN:'test-bot',SUPABASE_URL:'https://project.example',SUPABASE_SERVICE_ROLE_KEY:'server-key',TELEGRAM_WEBHOOK_SECRET:'webhook-secret'})[k]},serve:fn=>{handler=fn;}},createClient:()=>db,initWasm:async()=>{},fetch:async(url,options)=>{if(url.includes('api.telegram.org')){telegramCalls.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:true,result:{message_id:42}}));}return new Response(new Uint8Array(30000));},Request,Response,AbortSignal,URL,atob,TextDecoder,Uint8Array,Intl,console});
 const headers={authorization:'Bearer '+(bearer==='user'?'x.'+Buffer.from(JSON.stringify({aal})).toString('base64url')+'.x':bearer),'content-type':'application/json','x-radin-telegram-secret':secret};
 if(cron)headers['x-radin-cron-secret']='valid-cron';
 const response=await handler(new Request('https://project.example/worker',{method:'POST',headers,body:JSON.stringify(body)}));
 return {status:response.status,queried,data:await response.json(),telegramCalls};
}
test('trusted Telegram workload can process one story',async()=>{const r=await invoke({bearer:'server-key',secret:'webhook-secret'});assert.equal(r.status,200);assert.equal(r.queried,true);});
test('machine authorization rejects missing/wrong credentials and unrestricted work',async()=>{
 for(const input of [{bearer:'server-key'},{secret:'webhook-secret'},{bearer:'wrong',secret:'webhook-secret'},{bearer:'server-key',secret:'webhook-secret',body:{}},{bearer:'server-key',secret:'webhook-secret',body:{item_id:'not-a-uuid'}},{bearer:'user',secret:'webhook-secret'}]){
  const r=await invoke(input);assert.equal(r.status,401);assert.equal(r.queried,false);
 }
});
test('browser still requires AAL2 and allowlist; scheduled cron still works',async()=>{
 assert.equal((await invoke({bearer:'user',allowed:true})).status,401);
 assert.equal((await invoke({bearer:'user',aal:'aal2'})).status,401);
 assert.equal((await invoke({bearer:'user',aal:'aal2',allowed:true})).status,200);
 assert.equal((await invoke({cron:true})).status,200);
});

test('ready forwarded story receives real edit, publish and reject button payloads',async()=>{
 const r=await invoke({bearer:'server-key',secret:'webhook-secret',body:{item_id:itemId,trigger:'scheduled'},items:[{id:itemId,title:'خبر آزمایشی',summary:'متن خبر',source_type:'telegram',telegram_chat_id:9129058355,graphic_image_url:'https://images.example/poster.png'}]});
 assert.equal(r.status,200);assert.equal(r.data.results[0].preview_sent,true);
 const actions=r.telegramCalls[0].reply_markup.inline_keyboard.flat().map(x=>x.callback_data);
 assert.ok(actions.includes('publish:'+itemId));assert.ok(actions.includes('reject:'+itemId));
 assert.ok(actions.includes('edit:headline:'+itemId));assert.ok(actions.includes('edit:caption:'+itemId));
});
