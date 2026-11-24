'use strict';

// Only first-party native releases are update candidates. Upstream client
// versions and installer assets are deliberately not part of this protocol.
module.exports = Object.freeze({
  repository: 'jiwangyihao/welink-native-linux',
  api: 'https://api.github.com/repos/jiwangyihao/welink-native-linux/releases',
  releasePage: 'https://github.com/jiwangyihao/welink-native-linux/releases/tag/',
  timeoutMs: 15000,
  maxBytes: 4 * 1024 * 1024,
  maxPages: 10,
  pageSize: 100,
  maxManifestBytes: 256 * 1024,
  maxInstallerBytes: 512 * 1024 * 1024,
  downloadTimeoutMs: 15 * 60 * 1000,
  maxRedirects: 4
});
