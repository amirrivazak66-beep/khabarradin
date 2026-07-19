/* خبر رادین — تنظیمات اتصال به Supabase */
const SUPABASE_URL = 'https://gtbrkufbsllbosdyogfx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0YnJrdWZic2xsYm9zZHlvZ2Z4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0NTM0ODMsImV4cCI6MjEwMDAyOTQ4M30.PjcE502osdt7iAM7-TXSUGd2_bZcnzJ4ilzIYeASSKs';

window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
