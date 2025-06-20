import supabase from "../battlecode-backend/config/supabase.js";

// Express middleware for HTTP requests
const verifyAuthToken = async (req, res, next) => {
  const authToken = req.headers.authorization?.split(" ")[1];

  if (!authToken) {
    return res.status(401).json({ error: "No auth token provided" });
  }

  try {
    const { data, error } = await supabase.auth.getUser(authToken);

    if (error) {
      console.error("Auth error:", error);
      return res.status(401).json({ error: "Invalid or expired auth token" });
    }

    if (!data?.user) {
      return res.status(401).json({ error: "User not found" });
    }

    req.user = data.user;
    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// Socket.IO specific token verification (returns promise)
const verifySocketToken = async (token) => {
  if (!token) {
    throw new Error("No token provided");
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);

    if (error) {
      console.error("Socket auth error:", error);
      throw new Error("Invalid or expired auth token");
    }

    if (!data?.user) {
      throw new Error("User not found");
    }

    return data.user;
  } catch (err) {
    console.error("Socket auth verification error:", err);
    throw err;
  }
};

export default verifyAuthToken;
export { verifySocketToken };
