"use strict";

const diagnostics = require("./diagnostics");
const proxyHelpers = require("./proxy-helpers");
const stateStorage = require("./state-storage");
const browserCandidates = require("./browser-candidates");
const profileSanitizer = require("./profile-sanitizer");

module.exports = {
  ...diagnostics,
  ...proxyHelpers,
  ...stateStorage,
  ...browserCandidates,
  ...profileSanitizer,
};
