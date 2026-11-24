// Used by the signed-link entry point and by both sides of the media bridge.
// No I/O, credentials, or dependency on meeting state other than native downgrade.
(() => {
  'use strict';
  function requireOnlineLinkVariant(params, serverDowngrade = false, providerOrigin) {
    const fields = [];
    if (params?.isOfflineJoin !== undefined && params.isOfflineJoin !== false && params.isOfflineJoin !== 0)
      fields.push('isOfflineJoin');
    // In verified online mode the Windows SDK resolves the opaque ticket at
    // the issuer. The prefix is not part of the conference ID or the HTTP key.
    const prefix = params?.idPrefix;
    if (prefix != null && prefix !== '' && (typeof prefix !== 'string' || prefix === 'null' || prefix === 'undefined' ||
        typeof params.site_url !== 'string' || !params.site_url || typeof params.random !== 'string' || !params.random))
      fields.push('idPrefix');
    if (!fields.length && !serverDowngrade) {
      if (providerOrigin !== undefined && params?.site_url) {
        let site;
        try { site = new URL(params.site_url); }
        catch (_) { throw Object.assign(new Error('A configured HTTPS link site is required'), { code: 'INVALID_LINK_SITE' }); }
        // Windows resolves the ticket at the site's authority, not relative to
        // its path. Never navigate to this input or send a ticket to a new origin.
        if (site.protocol !== 'https:' || site.origin !== providerOrigin || site.username || site.password)
          throw Object.assign(new Error('Signed links require the configured HTTPS provider origin'), { code: 'LINK_ORIGIN_UNAVAILABLE' });
      }
      return;
    }
    const reason = serverDowngrade ? 'SERVER_DOWNGRADE' : 'UNSUPPORTED_LINK_FIELDS';
    const message = serverDowngrade ? 'The meeting service requires native downgrade entry' :
      'The online provider cannot handle native link fields: ' + fields.join(', ');
    throw Object.assign(new Error(message), { code: 'LINK_VARIANT_UNAVAILABLE', details: {
      reason, provider: 'vendor-signed-random', unsupportedFields: fields,
      supportedScope: 'configured-origin-online-link', callback: 'join-by-link', callbackFields: ['random'],
      joinAttempted: false, fallbackAttempted: false,
      manualAlternative: { kind: 'original-invitation-in-official-client', requiresOriginalInvitation: true,
        requiresExplicitUserSelection: true, variantSupport: 'must-be-confirmed-by-official-client',
        launched: false, joinConfirmed: false, documentationUrl: 'https://support.huaweicloud.com/clientuse-meeting/join_pc.html' }
    } });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = requireOnlineLinkVariant;
  else window.__welinkRequireOnlineLinkVariant = requireOnlineLinkVariant;
})();
