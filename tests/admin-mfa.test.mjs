import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../admin-mfa.js';
const { qrImageSource, enrollTotp } = globalThis.RadinMfa;
test('raw SVG QR is displayed as a data URI; unsafe sources are rejected', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
  assert.equal(decodeURIComponent(qrImageSource(svg).split(',')[1]), svg);
  assert.equal(qrImageSource('data:image/svg+xml;charset=utf-8,%3Csvg%3E'), 'data:image/svg+xml;charset=utf-8,%3Csvg%3E');
  assert.equal(qrImageSource('https://external.example/qr'), '');
  assert.equal(qrImageSource('javascript:alert(1)'), '');
});
test('restarting setup removes only unverified TOTP factors before enrollment', async () => {
  const removed = [];
  const mfa = { async unenroll({factorId}) { removed.push(factorId); return {}; }, async enroll() { return {data:{id:'new',totp:{secret:'TEST-ONLY',qr_code:'<svg/>'}}}; } };
  const result = await enrollTotp(mfa, {all:[{id:'old',factor_type:'totp',status:'unverified'},{id:'verified',factor_type:'totp',status:'verified'},{id:'phone',factor_type:'phone',status:'unverified'}]});
  assert.deepEqual(removed, ['old']);
  assert.equal(result.id, 'new');
});
test('failed cleanup stops enrollment instead of hiding a duplicate-factor error', async () => {
  let enrolled = false;
  const error = new Error('cleanup failed');
  await assert.rejects(enrollTotp({async unenroll(){ return {error}; },async enroll(){enrolled=true;}}, {all:[{id:'old',factor_type:'totp',status:'unverified'}]}), /cleanup failed/);
  assert.equal(enrolled, false);
});
