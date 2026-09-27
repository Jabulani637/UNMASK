'use strict';
/**
 * Every model in one place, so startup can build all the indexes without a list
 * that quietly stops matching the folder. A model that is not exported here does
 * not get its indexes, and an unindexed unique constraint is a rule nobody
 * enforces.
 */

module.exports = {
  User: require('./User'),
  Profile: require('./Profile'),
  Match: require('./Match'),
  Message: require('./Message'),
  Pass: require('./Pass'),
  Block: require('./Block'),
  Report: require('./Report'),
  Notification: require('./Notification'),
  AuditEvent: require('./AuditEvent'),
  Institution: require('./Institution'),
  InstitutionRequest: require('./InstitutionRequest'),
};
