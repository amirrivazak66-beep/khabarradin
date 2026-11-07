# Hosted email OTP setup

The frontend uses `signInWithOtp` and `verifyOtp({ email, token, type: 'email' })`.
Supabase sends a magic link by default despite the OTP method name. To send a
numeric code, update the hosted **Magic Link** email template:

1. Open https://supabase.com/dashboard/project/gtbrkufbsllbosdyogfx/auth/templates
2. Select **Magic Link**.
3. Set the subject to `کد یک‌بارمصرف خبر رادین`.
4. Replace the body with `magic_link.html` from this directory and save.

The required placeholder is `{{ .Token }}`, not `{{ .ConfirmationURL }}`.
Committing this template does not apply it to hosted Supabase Auth. The connected
Supabase tools cannot update Auth email settings. Apply this Dashboard setting
before expecting code delivery. It affects passwordless emails for this project.

After saving, request a new email from admin.html and verify that it contains a
code rather than a Sign in link. Test an invalid/expired code as well. Do not log
real codes or copy them into chat. Existing admin allowlist and Authenticator MFA
checks still run after email verification.

Reference: https://supabase.com/docs/guides/auth/auth-email-passwordless#with-otp
