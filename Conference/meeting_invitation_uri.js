// The campus scheme carries opaque tickets, not form data: a literal + is not a space.
// Decode each URI layer once. Parsing and formatting do not authenticate an invitation.
(() => {
  'use strict';
  const invalid = /[\r\n\0]/;

  function fields(query) {
    const result = Object.create(null);
    for (const part of query.split('&')) {
      if (!part) continue;
      const equals = part.indexOf('=');
      const key = decodeURIComponent(equals < 0 ? part : part.slice(0, equals));
      const value = equals < 0 ? '' : decodeURIComponent(part.slice(equals + 1));
      if (!key || invalid.test(key) || invalid.test(value) || Object.hasOwn(result, key)) return null;
      result[key] = value;
    }
    return result;
  }

  // The portal publishes site + "&random=" + ticket [+ "&idPrefix=" + prefix],
  // either verbatim or Base64 over the UTF-8 bytes. These are issuer values,
  // not another form-encoded query: even %2F inside the site is significant.
  const httpSite = /^https?:\/\//i;
  function portalFields(payload, boundary) {
    const site = payload.slice(0, boundary);
    const suffix = payload.slice(boundary + '&random='.length).split('&');
    if (!suffix[0] || suffix.length > 2 || (suffix.length === 2 && !suffix[1].startsWith('idPrefix='))) return null;
    // Do not absorb an outer admission field into a supposed nested site URL.
    if (site.includes('&') && (!site.includes('?') || /&(?:site_url|random|idPrefix|joinType|conferenceID|confId|meetingType|user_name)=/.test(site))) return null;
    const result = Object.assign(Object.create(null), { site_url: site, random: suffix[0] });
    if (suffix.length === 2) result.idPrefix = suffix[1].slice('idPrefix='.length);
    return result;
  }

  function parse(uri) {
    if (typeof uri !== 'string') return null;
    const q = uri.indexOf('?');
    if (q < 0) return null;
    try {
      const query = uri.slice(q + 1);
      if (invalid.test(query)) return null;
      if (/^site_url=https?:\/\//i.test(query)) {
        const plain = query.slice('site_url='.length);
        const boundary = plain.indexOf('&random=');
        if (boundary !== -1) {
          // Only the publisher's first two values are opaque. Additional app
          // options use normal URI escaping, even on an otherwise raw link.
          let tail = plain.indexOf('&', boundary + '&random='.length);
          if (tail !== -1 && plain.startsWith('&idPrefix=', tail))
            tail = plain.indexOf('&', tail + '&idPrefix='.length);
          const portal = portalFields(tail === -1 ? plain : plain.slice(0, tail), boundary);
          if (portal) {
            if (tail === -1) return portal;
            const outer = fields(plain.slice(tail + 1));
            if (!outer || Object.keys(outer).some(key => Object.hasOwn(portal, key))) return null;
            return Object.assign(portal, outer);
          }
        }
      }
      const result = fields(query);
      if (result?.site_url && !result.site_url.includes(':')) {
        let bytes;
        try { bytes = atob(result.site_url); } catch (_) { return result; }
        if (!httpSite.test(bytes)) return result;
        let decoded;
        try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes, c => c.charCodeAt(0))); }
        catch (_) { return null; }
        if (invalid.test(decoded)) return null;
        const boundary = decoded.indexOf('&random=');
        if (boundary === -1) result.site_url = decoded; // Older clients wrap only the site.
        else {
          const portal = portalFields(decoded, boundary);
          if (!portal || Object.hasOwn(result, 'random') ||
              (Object.hasOwn(portal, 'idPrefix') && Object.hasOwn(result, 'idPrefix'))) return null;
          Object.assign(result, portal);
        }
      }
      return result;
    } catch (error) { if (error instanceof URIError) return null; throw error; }
  }

  function signed(params) {
    const query = [];
    for (const [key, value] of Object.entries(params)) {
      if (value != null) query.push(key + '=' + encodeURIComponent(value));
    }
    return 'hwwelink://welinksoftclient/page/link?' + query.join('&');
  }

  function publicLink(link, wrapper = {}) {
    if (typeof link !== 'string' || invalid.test(link) || link.includes('\\') || link.trim() !== link) return null;
    try {
      const url = new URL(link);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          link.slice(link.indexOf('//') + 2).split(/[/?#]/, 1)[0].includes('@') || !url.hash.startsWith('#/j/')) return null;
      const tail = url.hash.slice(4), q = tail.indexOf('?');
      const parts = (q < 0 ? tail : tail.slice(0, q)).split('/');
      if (!parts[0] || parts.length > 2) return null;
      const outer = fields(url.search.slice(1)), inner = fields(q < 0 ? '' : tail.slice(q + 1));
      if (!outer || !inner) return null;
      const options = {};
      for (const key of ['joinType', 'channelType', 'idPrefix', 'meetingType']) {
        for (const values of [outer, inner, wrapper]) {
          if (values[key] == null) continue;
          if (key in options && options[key] !== values[key]) return null;
          options[key] = values[key];
        }
      }
      const confId = decodeURIComponent(parts[0]), password = decodeURIComponent(parts[1] || '');
      if (invalid.test(confId) || invalid.test(password)) return null;
      if (wrapper.conferenceID && wrapper.conferenceID !== confId) return null;
      return { confId, password, origin: url.origin, ...options };
    } catch (error) { if (error instanceof URIError || error instanceof TypeError) return null; throw error; }
  }

  function needsNativeVariant(params) {
    return (params.idPrefix != null && params.idPrefix !== '') || params.joinType === 'offline' || params.isOfflineJoin === true;
  }

  // The same ID lengths are used by HWM and legacy XY. Only the configured
  // HWM issuer can supply a site prefix that is absent from its public link.
  function usesLegacyXY(invite, loginAuthority) {
    if ((invite.confId.length !== 10 && invite.confId.length !== 12) || needsNativeVariant(invite)) return false;
    if (invite.meetingType === '8' || invite.channelType === 'cdn' || !loginAuthority) return true;
    try {
      const issuer = new URL('https://' + loginAuthority);
      return !!(issuer.username || issuer.password || issuer.search || issuer.hash) || issuer.pathname !== '/' ||
        issuer.origin !== invite.origin;
    } catch (_) { return true; }
  }

  function httpsURL(value) {
    if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value) ||
        !/^https:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)) return null;
    try {
      const url = new URL(value), authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0];
      return url.protocol === 'https:' && url.hostname && !url.hostname.includes('*') && !authority.includes('@') &&
        !url.username && !url.password && !value.includes('#') ? url : null;
    } catch (_) { return null; }
  }

  // Validation and formatting only: supplied replies and URLs authenticate
  // nothing. Main owns authConf and issues from its own response before returning
  // the facade reply. This globally callable helper never sends or grants IPC.
  function issued(reply, invite, userName, requestURL) {
    if (!reply || typeof reply.siteUrl !== 'string' || !reply.siteUrl || typeof reply.random !== 'string' || !reply.random ||
        (reply.idPrefix != null && typeof reply.idPrefix !== 'string') ||
        (invite.idPrefix && invite.idPrefix !== reply.idPrefix)) return { failure: failure() };
    const fields = { site_url: reply.siteUrl, random: reply.random, user_name: userName,
      conferenceID: invite.confId, idPrefix: reply.idPrefix, joinType: invite.joinType };
    const issuer = httpsURL(requestURL), site = httpsURL(fields.site_url);
    if (!issuer || !site || issuer.pathname !== '/v1/mmc/management/conferences/authConf' ||
        Array.from(issuer.searchParams).length !== 1 || issuer.searchParams.get('conferenceID') !== invite.confId)
      return { failure: failure() };
    // Ordinary and offline invitations retain their existing admission path.
    // A raw scheme, a public-link prefix or a claimed trusted flag cannot issue.
    if (!fields.idPrefix || fields.joinType === 'offline' || issuer.origin === site.origin) return { fields };
    if (!fields.idPrefix.trim() || fields.idPrefix === 'null' || fields.idPrefix === 'undefined' ||
        /[\u0000-\u001f\u007f]/.test(fields.idPrefix + fields.random + fields.conferenceID) ||
        (fields.joinType != null && fields.joinType !== '' && fields.joinType !== 'online'))
      return { failure: failure() };
    return { fields };
  }

  function nativeParams(fields, name = fields.user_name) {
    return { random: fields.random, site_url: fields.site_url, nick_name: name, idPrefix: fields.idPrefix,
      confId: fields.conferenceID || fields.confId || '', isOfflineJoin: fields.joinType === 'offline' };
  }

  function failure(reason = 'INVALID_MEETING_INVITATION') { return { result: 1, param: { reason_code: reason } }; }

  window.__welinkInvitation = Object.freeze({ parse, signed, publicLink, issued, nativeParams, needsNativeVariant, usesLegacyXY, failure });
})();
