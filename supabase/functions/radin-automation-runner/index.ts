import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json; charset=utf-8"};
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:cors});
 const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!key)return new Response(JSON.stringify({error:"Server configuration missing"}),{status:500,headers:cors});
 const supplied=req.headers.get("x-radin-cron-secret")||"";
 const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:authorized,error:authError}=await db.rpc("verify_radin_cron_secret",{candidate:supplied});
 if(authError||authorized!==true)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:cors});
 const results=[];
 EdgeRuntime.waitUntil((async()=>{
  try{
   const response=await fetch(url+"/functions/v1/rss-ingest",{method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json","x-radin-cron-secret":supplied},body:"{}",signal:AbortSignal.timeout(45000)});
   if(!response.ok)throw new Error("RSS ingest failed: "+response.status);
  }catch(e){console.error("Background RSS ingest failed",e instanceof Error?e.message:"unknown");}
 })());
 try{
  const response=await fetch(url+"/functions/v1/radin-graphic-worker",{method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json","x-radin-cron-secret":supplied},body:JSON.stringify({trigger:"scheduled"}),signal:AbortSignal.timeout(140000)});
  let payload:any={};try{payload=await response.json()}catch{}
  if(!response.ok)throw new Error("Graphic worker failed: "+response.status+" "+JSON.stringify(payload).slice(0,300));
  results.push({task:"radin-graphic-worker",ok:true,result:payload});
 }catch(e){results.push({task:"radin-graphic-worker",ok:false,error:e instanceof Error?e.message:"unknown"});}
 return new Response(JSON.stringify({ok:results.every(x=>x.ok),results,publication:"manual approval remains required"}),{status:200,headers:cors});
});