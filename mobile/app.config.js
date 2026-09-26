const appJson = require('./app.json');

module.exports = ({ config }) => {
  const googleMapsApiKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
  const plugins = [...(config.plugins ?? appJson.expo.plugins)];

  plugins.push([
    'react-native-maps',
    googleMapsApiKey ? { androidGoogleMapsApiKey: googleMapsApiKey } : {},
  ]);
  plugins.push('react-native-quick-crypto');

  return {
    ...appJson.expo,
    ...config,
    plugins,
  };
};
