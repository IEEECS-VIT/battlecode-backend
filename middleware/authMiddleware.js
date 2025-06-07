import supabase from "../config/supabase.js";

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

export default verifyAuthToken;
