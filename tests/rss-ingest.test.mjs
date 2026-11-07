import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/rss-ingest/index.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''));
function setup({ rpcResult = { data: false, error: null }, user = null, aal = 'aal1', allowed = false, insertError = null, xml = '<rss><channel><item><title>Story</title><link>https://news.example/1</link></item></channel></rss>' } = {}) {
  let handler;
  const calls = { rpc: [], inserted: [], updates: [], feeds: 0 };
  const stored = new Map();
  const db = {
    async rpc(name, args) { calls.rpc.push({ name, args }); return rpcResult; },
    from(table) {
      if (table === 'web_admin_emails') return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: allowed ? { email: user.email } : null, error: null }) }) }) }) };
      if (table === 'rss_feeds') return {
        select() { calls.feeds++; return { eq: () => ({ order: () => ({ limit: async () => ({ data: [{ id: 'feed1', url: 'https://feed.example/rss', item_count: 10 }], error: null }) }) }) }; },
        update(data) { calls.updates.push(data); return { eq: async () => ({ error: null }) }; }
      };
      if (table === 'news_items') return {
        upsert(rows, options) {
          assert.equal(options.onConflict, 'source_url');
          assert.equal(options.ignoreDuplicates, true);
          return { select: async () => {
            if (insertError) return { data: null, error: insertError };
            const added = rows.filter(row => !stored.has(row.source_url));
            for (const row of added) stored.set(row.source_url, row);
            calls.inserted.push(...added);
            return { data: added, error: null };
          } };
        }
      };
      throw new Error('Unexpected table: ' + table);
    }
  };
  vm.runInNewContext(source, {
    Deno: { env: { get: key => ({ SUPABASE_URL: 'https://project.example', SUPABASE_SERVICE_ROLE_KEY: 'server-key', SUPABASE_ANON_KEY: 'anon-key' })[key] }, serve: fn => { handler = fn; } },
    createClient: (_url, key) => key === 'server-key' ? db : { auth: { getUser: async () => ({ data: { user }, error: null }) } },
    Request, Response, URL, TextDecoder, Uint8Array, atob, AbortSignal,
    fetch: async () => new Response(xml)
  });
  const token = 'x.' + Buffer.from(JSON.stringify({ aal })).toString('base64url') + '.x';
  return { calls, invoke: (headers = {}) => handler(new Request('https://project.example/functions/v1/rss-ingest', { method: 'POST', headers })), token };
}
test('Vault-authorized cron stores pending, unpublished news', async () => {
  const s = setup({ rpcResult: { data: true, error: null } });
  const r = await s.invoke({ 'x-radin-cron-secret': 'valid-cron' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).totalUpserted, 1);
  assert.equal(s.calls.rpc[0].name, 'verify_radin_cron_secret');
  assert.equal(s.calls.inserted[0].published, false);
  assert.equal(s.calls.inserted[0].review_status, 'pending');
});
test('invalid, absent and failed cron authorization never loads feeds', async () => {
  for (const config of [{}, { rpcResult: { data: null, error: { message: 'unavailable' } } }]) {
    const s = setup(config);
    const r = await s.invoke({ 'x-radin-cron-secret': 'wrong', authorization: 'Bearer server-key' });
    assert.ok([403, 503].includes(r.status));
    assert.equal(s.calls.feeds, 0);
  }
  const s = setup();
  assert.equal((await s.invoke()).status, 401);
  assert.equal(s.calls.rpc.length, 0);
  assert.equal(s.calls.feeds, 0);
});
test('manual ingest still requires verified, allowlisted AAL2 admin', async () => {
  for (const [aal, allowed, verified, status] of [['aal1', true, true, 403], ['aal2', false, true, 403], ['aal2', true, false, 403], ['aal2', true, true, 200]]) {
    const s = setup({ user: { email: 'admin@example.com', email_confirmed_at: verified ? '2026-01-01' : null }, aal, allowed });
    assert.equal((await s.invoke({ authorization: 'Bearer ' + s.token })).status, status);
    assert.equal(s.calls.feeds, status === 200 ? 1 : 0);
  }
});
test('plain PostgREST errors are reported and persisted', async () => {
  const s = setup({ rpcResult: { data: true, error: null }, insertError: { message: 'duplicate source_url', code: '23505' } });
  const data = await (await s.invoke({ 'x-radin-cron-secret': 'valid-cron' })).json();
  assert.equal(data.ok, false);
  assert.equal(data.reports[0].error, 'duplicate source_url');
  assert.equal(s.calls.updates[0].last_error, 'duplicate source_url');
});

test('long Persian URLs and repeated ingestion do not overwrite existing stories', async () => {
  const link = 'https://news.example/' + encodeURIComponent('خبر'.repeat(300));
  const item = `<item><title>Story</title><link>${link}</link></item>`;
  const s = setup({ rpcResult: { data: true, error: null }, xml: `<rss>${item}${item}</rss>` });
  const headers = { 'x-radin-cron-secret': 'valid-cron' };
  const first = await (await s.invoke(headers)).json();
  assert.equal(first.totalFetched, 2);
  assert.equal(first.totalUpserted, 1);
  assert.equal(s.calls.inserted.length, 1);
  s.calls.inserted[0].published = true;
  s.calls.inserted[0].review_status = 'approved';
  const second = await (await s.invoke(headers)).json();
  assert.equal(second.totalUpserted, 0);
  assert.equal(s.calls.inserted[0].published, true);
  assert.equal(s.calls.inserted[0].review_status, 'approved');
});
