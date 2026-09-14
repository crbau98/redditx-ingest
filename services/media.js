const db = require('../db');
const { looksFemaleTagged, isJunkTitle } = require('./media-quality');

module.exports = {
  list(params) {
    const result = db.listMedia(params);
    const publicView = !params.publishState || params.publishState === 'published';
    if (!publicView) return result;
    result.items = result.items.filter((row) => {
      if (isJunkTitle(row.title)) return false;
      const blob = [row.title, row.author, row.subreddit].join(' ');
      return !looksFemaleTagged(blob, { gayContext: true });
    });
    return result;
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

  getSourcePlatforms() {
    return db.getSourcePlatforms();
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
