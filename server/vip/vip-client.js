'use strict';
// The VIP consumer seam is openvibe-sdk/vip (createVipClient, createVipCache), published once for every
// product instead of a copy of openvibe-vip/client in each. Kept at this path so callers do not change.
module.exports = require('openvibe-sdk/vip');
