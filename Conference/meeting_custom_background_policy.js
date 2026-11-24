/* Policy-only observer for main.3ee85ed7.js modules 15300/33556/62467.
 * Observe the genuine application request, never issue one or change its result.
 * The ordinary support selector intentionally collapses 'forced' and 'enable';
 * it must never authorize a custom image without the underlying provider flags.
 */
(() => {
  'use strict';
  window.__welinkObserveCustomBackgroundPolicy = function ({ vendor, loadModule, changed }) {
    const http = loadModule(15300).default;
    const constants = vendor.constants;
    let policy = null;
    const auth = () => vendor.selectors.selectAuthInfo(vendor.store.getState()) || {};
    const token = () => vendor.selectors.selectLoginInfo(vendor.store.getState())?.accessToken;
    const corp = () => auth().confServiceTp ? auth().confCompanyID : null;
    function readParam(list, name) {
      if (!Array.isArray(list)) return undefined;
      const entries = list.filter(value => value?.paramKey === name);
      return entries.length === 1 ? entries[0].paramValue : undefined;
    }
    function isPolicyResponse(response) {
      try {
        const config = response.config;
        const url = new URL(config.url, config.baseURL || location.href);
        return url.origin === location.origin && url.pathname === '/v1/usg/acs/ap/userservicedata';
      } catch { return false; }
    }
    const interceptor = http.interceptors.response.use(response => {
      if (!isPolicyResponse(response)) return response;
      const headers = response.config.headers;
      const ownerToken = headers?.get?.('X-Auth-Token') || headers?.['X-Auth-Token'] || headers?.['x-auth-token'];
      policy = { token: ownerToken, corp: response.config.params?.corpId ?? null, valid: false };
      if (response.httpStatus === 200 && response.code === constants.RET_SUCCESS_200) {
        const user = response.data?.userCfg?.paramList, company = response.data?.corpCfg?.paramList;
        // Both lists must be present: missing policy is not permission.
        policy.valid = Array.isArray(user) && Array.isArray(company) &&
          user.filter(value => value?.paramKey === 'virtualBackground').length <= 1 &&
          company.filter(value => value?.paramKey === 'webVirtualBackGround').length <= 1;
        policy.user = readParam(user, 'virtualBackground');
        policy.company = readParam(company, 'webVirtualBackGround');
      }
      changed();
      return response;
    });
    return {
      state() {
        const current = vendor.store.getState();
        let reason = null;
        if (!policy?.valid || !policy.token || policy.token !== token() || policy.corp !== corp())
          reason = 'BACKGROUND_PROVIDER_POLICY_UNKNOWN';
        else if (policy.user === constants.VIRTUAL_BACKGROUND_STATUS.FORCED)
          reason = 'BACKGROUND_PROVIDER_FORCED';
        else if (policy.user !== constants.VIRTUAL_BACKGROUND_STATUS.ENABLE &&
            policy.company !== constants.CORP_VIRTUAL_BACKGROUND_STATUS.TRUE)
          reason = 'BACKGROUND_PROVIDER_DISABLED';
        else if (vendor.selectors.getServiceDataIsSupportVirtualBackground(current) !== constants.SUPPORT_VIRTUAL_BACKGROUND.SUPPORT)
          reason = 'BACKGROUND_PROVIDER_DISABLED';
        else if (vendor.selectors.selectIsEnableVirtualBackground(current) ||
            vendor.selectors.selectCurrentVirtualBackgroundOperate(current) === constants.VIRTUAL_BACKGROUND_OPERATE.START)
          reason = 'BACKGROUND_SERVER_EFFECT_ACTIVE';
        return { allowed: !reason, reason, source: 'observed-vendor-userservicedata',
          prerequisite: reason === 'BACKGROUND_PROVIDER_POLICY_UNKNOWN' ?
            'The current meeting must receive its normal authenticated user/corporate background policy; rejoin through the provider if that response predates this owner.' :
            reason === 'BACKGROUND_PROVIDER_FORCED' ? 'An enterprise administrator must remove the forced provider background; local effects cannot override it.' :
            reason === 'BACKGROUND_SERVER_EFFECT_ACTIVE' ? 'Turn off the optional provider background in the provider UI first; mandatory backgrounds cannot be overridden.' :
            reason ? 'The provider must permit optional virtual backgrounds for this user or enterprise.' : null };
      },
      dispose() { http.interceptors.response.eject(interceptor); policy = null; }
    };
  };
})();
