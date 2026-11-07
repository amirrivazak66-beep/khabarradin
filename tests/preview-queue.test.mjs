import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {test} from 'node:test';
const source=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/radin-preview-queue/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,''));
const job={item_id:'00000000-0000-0000-0000-000000000001',chat_id:111,lease_token:'lease',attempts:1};
function setup({fail=false,stale=false,idle=false}={}){
 let handler,release;const background=[],rpc=[],calls=[];
 const work=new Promise(resolve=>{release=resolve;});
 const db={async rpc(name,args){rpc.push({name,args});return {data:name==='claim_radin_preview'?(idle?[]:[job]):name==='finish_radin_preview'?!stale:name==='verify_radin_cron_secret'?true:0,error:null};},from(){return {select:()=>({eq:()=>({maybeSingle:async()=>({data:{published:false,review_status:'pending'},error:null})})}),insert:async()=>({error:null})};}};
 vm.runInNewContext(source,{Deno:{env:{get:k=>({SUPABASE_URL:'https://project.example',SUPABASE_SERVICE_ROLE_KEY:'server-key',TELEGRAM_WEBHOOK_SECRET:'webhook-secret'})[k]},serve:fn=>{handler=fn;}},createClient:()=>db,EdgeRuntime:{waitUntil:p=>background.push(p)},Request,Response,AbortSignal,console,fetch:async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body)});
  if(url.endsWith('/radin-graphic-worker')){await work;return new Response(JSON.stringify(fail?{error:'render failed'}:{results:[{id:job.item_id,ok:true}]}),{status:fail?500:200});}
  return new Response('{}');
 }});
 return {rpc,calls,release,background,invoke:(headers={authorization:'Bearer server-key','x-radin-telegram-secret':'webhook-secret'})=>handler(new Request('https://project.example/queue',{method:'POST',headers}))};
}
test('queue acknowledges before slow rendering finishes, then fills and wakes the next job',async()=>{
 const s=setup();const response=await s.invoke();assert.equal(response.status,202);
 assert.equal(s.rpc.some(x=>x.name==='finish_radin_preview'),false);
 s.release();await Promise.all(s.background);
 assert.ok(s.rpc.some(x=>x.name==='finish_radin_preview'&&x.args.p_lease==='lease'&&x.args.p_error===null));
 assert.equal(s.rpc.filter(x=>x.name==='fill_radin_publish_queue').length,2);
 assert.ok(s.calls.some(x=>x.url.endsWith('/radin-preview-queue')));
});
test('render failure persists retry state without scheduling failed content',async()=>{
 const s=setup({fail:true});await s.invoke();s.release();await Promise.all(s.background);
 assert.equal(s.rpc.find(x=>x.name==='finish_radin_preview').args.p_error,'render failed');
 assert.equal(s.rpc.filter(x=>x.name==='fill_radin_publish_queue').length,1);
});
test('stale worker does not continue the queue after losing its lease',async()=>{
 const s=setup({stale:true});await s.invoke();s.release();await Promise.all(s.background);
 assert.equal(s.calls.some(x=>x.url.endsWith('/radin-preview-queue')),false);
});
test('unauthorized requests cannot claim or schedule; cron accepts an idle queue',async()=>{
 const s=setup({idle:true});assert.equal((await s.invoke({})).status,401);assert.equal(s.rpc.length,0);
 assert.equal((await s.invoke({'x-radin-cron-secret':'valid-cron'})).status,200);
 assert.equal(s.background.length,0);
});
