'use strict';

// Only first-party native releases are update candidates. Upstream client
// versions and installer assets are deliberately not part of this protocol.
module.exports = Object.freeze({
  repository: 'jiwangyihao/welink-native-linux',
  channelManifest: 'https://github.com/jiwangyihao/welink-native-linux/releases/latest/download/native-update.json',
  releasePage: 'https://github.com/jiwangyihao/welink-native-linux/releases/tag/',
  timeoutMs: 15000,
  maxManifestBytes: 256 * 1024,
  maxInstallerBytes: 512 * 1024 * 1024,
  downloadTimeoutMs: 15 * 60 * 1000,
  maxRedirects: 4
});
