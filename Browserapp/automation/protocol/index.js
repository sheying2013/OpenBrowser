'use strict';

module.exports = {
  windowSync: require('./ads-window-sync-protocol'),
  rpa: require('./ads-rpa-registry'),
  appCenter: require('./ads-app-center-protocol'),
  eventMap: require('./ads-event-map'),
  fanout: require('./sync-fanout'),
  platform: require('./cross-platform'),
};
