const db = require('../db');

module.exports = {
  getQueue(params) {
    return db.getModerationQueue(params);
  },

  moderate(mediaId, action, reason, actor = 'admin') {
    const media = db.getMedia(mediaId);
    if (!media) return null;

    db.insertModerationAction({
      target_type: 'media',
      target_id: mediaId,
      action,
      reason: reason || null,
      actor
    });

    // State transitions based on action
    const updates = { id: mediaId };
    switch (action) {
      case 'approve':
        updates.publish_state = 'published';
        updates.orientation_scope = 'gay';
        break;
      case 'reject':
        updates.publish_state = 'removed';
        updates.orientation_scope = 'excluded_straight';
        break;
      case 'hide':
        updates.publish_state = 'hidden';
        break;
      case 'flag':
        updates.publish_state = 'review';
        break;
      case 'publish':
        updates.publish_state = 'published';
        break;
    }

    db.updateMedia(updates);
    return db.getMedia(mediaId);
  },

  getActions(targetId) {
    return db.getModerationActions(targetId);
  }
};
