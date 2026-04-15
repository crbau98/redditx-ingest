module.exports = function adminAuth(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    // No admin key configured — allow access (development mode)
    return next();
  }

  const provided = req.headers['x-admin-key'];
  if (!provided || provided !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing admin key' });
  }

  next();
};
