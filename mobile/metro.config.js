const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
config.resolver.unstable_conditionNames = ['browser'];

// Privy's published package map is not recognized correctly by this Metro
// version. Point directly at its ESM entry while retaining package exports for
// the SDK's dependencies.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@privy-io/expo') {
    return {
      type: 'sourceFile',
      filePath: path.join(__dirname, 'node_modules/@privy-io/expo/dist/esm/index.js'),
    };
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
