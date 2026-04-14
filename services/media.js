const db = require('../db');

module.exports = {
  list(params) {
    return db.listMedia(params);
  },

  get(id) {
    const media = db.getMedia(id);
    if (!media) return null;
    media.tags = db.getMediaTags(id);
    return media;
  },

  getRelated(id, limit) {
    return db.getRelatedMedia(id, limit);
  },

  update(id, data) {
    return db.updateMedia({ id, ...data });
  },

  remove(id) {
    return db.deleteMedia(id);
  },

  getSubreddits() {
    return db.getSubreddits();
  },

  getStats() {
    return db.getStats();
  },

  addTag(mediaId, tagName, source) {
    return db.addTagToMedia(mediaId, tagName, source);
  },

  getTags(limit) {
    return db.listTags(limit);
  },

  getMediaByTag(tagName, params) {
    return db.listMedia({ ...params, tag: tagName });
  }
};
