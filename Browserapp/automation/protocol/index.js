'use strict';

module.exports = {
  windowSync: require('./window-sync-protocol'),
  rpa: require('./rpa-registry'),
  appCenter: require('./app-center-protocol'),
  eventMap: require('./event-map'),
  fanout: require('./sync-fanout'),
  windowGeneration: require('./window-generation'),
  platform: require('./cross-platform'),
};
