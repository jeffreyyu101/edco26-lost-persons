exports.normalizeSupabaseUrl = function normalizeSupabaseUrl(configuredUrl) {
  return configuredUrl?.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
};
