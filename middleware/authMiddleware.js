import supabase from '../config/supabase.js';

const verifyAuthToken = async (req, res, next) => {
  const authToken = req.headers.authorization?.split(' ')[1]; // Extract token from Bearer header

  if (!authToken) {
    return res.status(401).json({ error: 'No auth token provided' });
  }

  const { data: user, error } = await supabase.auth.getUser(authToken);

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }

  req.user = user; // Attach user info to the request object
  next();
};

export default verifyAuthToken;