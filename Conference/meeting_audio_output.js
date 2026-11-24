/* Actual HTML media output completion, independent of HRTC's optimistic cache. */
(function (scope, factory) {
  'use strict';
  const api = factory(scope);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.WelinkAudioOutput = api;
})(typeof globalThis === 'object' ? globalThis : window, function (scope) {
  'use strict';
  async function apply({ elements, deviceId, ensureCurrent }) {
    if (!Array.isArray(elements) || typeof deviceId !== 'string' || typeof ensureCurrent !== 'function')
      throw Object.assign(new Error('Explicit audio output and current media ownership are required'), { code: 'INVALID_AUDIO_OUTPUT_REQUEST' });
    // The browser API uses the explicit empty string for the system default.
    // Public device.select still requires an enumerated, exposed device ID.
    const sinks = Array.from(new Set(elements));
    let applied = 0;
    for (const element of sinks) {
      ensureCurrent();
      if (!element || typeof element.setSinkId !== 'function' || typeof element.sinkId !== 'string' ||
          typeof scope.HTMLMediaElement === 'function' && !(element instanceof scope.HTMLMediaElement))
        throw Object.assign(new Error('The receiving player has no genuine selectable media sink'), { code: 'AUDIO_OUTPUT_UNAVAILABLE' });
      try {
        await element.setSinkId(deviceId);
      } catch (error) {
        throw Object.assign(new Error('The audio output rejected the requested route: ' + String(error && error.message || error)), {
          code: 'AUDIO_OUTPUT_SELECTION_FAILED',
          details: { appliedOutputs: applied, totalOutputs: sinks.length,
            causeName: error && error.name || 'Error', causeCode: error && error.code !== undefined ? error.code : null }
        });
      }
      ensureCurrent();
      if (element.sinkId !== deviceId)
        throw Object.assign(new Error('The actual receiving player did not retain the requested audio output'), {
          code: 'AUDIO_OUTPUT_UNCONFIRMED', details: { appliedOutputs: applied, totalOutputs: sinks.length }
        });
      applied += 1;
    }
    ensureCurrent();
    return { sinkCount: sinks.length, verified: sinks.length > 0 };
  }
  return Object.freeze({ apply });
});
