/* Authenticator setup helpers. Secrets remain in the signed-in page only. */
(function (root) {
  'use strict';
  const qrImageSource = value => {
    const qr = String(value || '').trim();
    if (qr.startsWith('<svg') || qr.startsWith('<?xml')) {
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qr);
    }
    return /^data:image\/(?:svg\+xml|png);/i.test(qr) ? qr : '';
  };
  async function enrollTotp(mfa, factors) {
    // A cancelled/reloaded setup can leave an unverified factor with the same
    // friendly name. Only remove unfinished TOTP factors belonging to this user.
    for (const factor of factors?.all || factors?.totp || []) {
      if (factor.status !== 'unverified' || factor.factor_type !== 'totp') continue;
      const { error } = await mfa.unenroll({ factorId: factor.id });
      if (error) throw error;
    }
    const { data, error } = await mfa.enroll({
      factorType: 'totp', friendlyName: 'Radin News Admin', issuer: 'Radin News'
    });
    if (error) throw error;
    if (!data?.id || !data.totp?.secret) throw new Error('Authenticator setup incomplete');
    return data;
  }
  root.RadinMfa = { qrImageSource, enrollTotp };
})(globalThis);
