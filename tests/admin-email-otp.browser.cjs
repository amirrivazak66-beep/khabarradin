const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const b=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const digits=process.env.EMAIL_OTP_TEST_CODE||'12345678';
const p=await b.newPage({viewport:{width:390,height:850}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
await p.route('**/cdn.jsdelivr.net/**',r=>r.fulfill({contentType:'application/javascript',body:''}));
await p.route('**/app.js',r=>r.fulfill({contentType:'application/javascript',body:''}));
await p.route('**/supabase-config.js',r=>r.fulfill({contentType:'application/javascript',body:`
window.calls={sent:[],verified:[],enrolled:0};
window.sb={functions:{invoke:async()=>({data:{ok:true,admin:true,mfaRequired:true}})},auth:{
 getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>{},signOut:async()=>{},
 signInWithOtp:async x=>{calls.sent.push(x);return{};},verifyOtp:async x=>{calls.verified.push(x);return x.token==='${digits}'?{data:{session:{access_token:'test-session',user:{email:x.email}}}}:{error:{message:'expired'}};},
 mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal1'}}),listFactors:async()=>({data:{all:[],totp:[]}}),enroll:async()=>{calls.enrolled++;return {data:{id:'factor',totp:{secret:'TESTONLYKEY',qr_code:'<svg/>'}}};}}}};` }));
await p.goto((process.env.TEST_BASE_URL||'http://127.0.0.1:8766')+'/admin.html',{waitUntil:'networkidle'});
assert.equal(await p.locator('#emailOtpPanel').isVisible(),false);
await p.locator('#email').fill('Admin@Example.com');await p.locator('#loginBtn').click();
await p.locator('#emailOtpPanel').waitFor({state:'visible'});
assert.deepEqual(await p.evaluate(()=>calls.sent[0]),{email:'admin@example.com',options:{shouldCreateUser:false}});
assert.equal(await p.evaluate(()=>calls.enrolled),0);
await p.locator('#emailOtpCode').fill('000000');await p.locator('#verifyEmailOtpBtn').click();
await p.waitForFunction(()=>document.getElementById('emailOtpError').textContent.includes('منقضی'));
assert.equal(await p.locator('#totpPanel').isVisible(),false);
await p.locator('#email').fill('another@example.com');assert.equal(await p.locator('#emailOtpPanel').isVisible(),false);
await p.locator('#loginBtn').click();await p.locator('#emailOtpPanel').waitFor({state:'visible'});
assert.equal(await p.locator('#emailOtpCode').getAttribute('maxlength'),'8');
assert.equal(await p.locator('#totpCode').getAttribute('maxlength'),'6');
await p.locator('#emailOtpCode').fill('1234567');await p.locator('#verifyEmailOtpBtn').click();
assert.equal(await p.evaluate(()=>calls.verified.length),1);
await p.locator('#emailOtpCode').fill(digits.replace(/[0-9]/g,x=>'۰۱۲۳۴۵۶۷۸۹'[Number(x)]));assert.equal(await p.locator('#emailOtpCode').inputValue(),digits);
await p.locator('#verifyEmailOtpBtn').click();await p.locator('#totpPanel').waitFor({state:'visible'});
assert.deepEqual(await p.evaluate(()=>calls.verified.at(-1)),{email:'another@example.com',token:digits,type:'email'});
assert.equal(await p.locator('#emailOtpPanel').isVisible(),false);
assert.equal(await p.locator('#emailOtpCode').inputValue(),'');
assert.equal(await p.evaluate(()=>calls.enrolled),1);
assert.equal(await p.locator('#dashboard').evaluate(x=>x.classList.contains('show')),false);
assert.deepEqual(errors,[]);
console.log('PASS: email-code request, invalid-code rejection, email binding, Persian digits, in-page verification, MFA preserved; no real email sent.');await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
