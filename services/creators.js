const db = require('../db');

module.exports = {
  list(params) {
    return db.listCreators(params);
  },

  get(id) {
    const creator = db.getCreator(id);
    if (!creator) return null;
    creator.sources = db.getCreatorSources(id);
    return creator;
  },

  getMedia(creatorId, params) {
    return db.listMedia({ ...params, creator: creatorId });
  },

  update(id, data) {
    return db.updateCreator({ id, ...data });
  },

  merge(keepId, mergeId) {
    return db.mergeCreators(keepId, mergeId);
  }
};
