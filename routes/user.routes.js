import { Router } from "express";
import prisma from "../config/prisma.js";
import verifyAuthToken from "../middleware/authMiddleware.js";

const router = Router();

router.post("/verify", verifyAuthToken, async (req, res) => {
  try {
    // The verifyAuthToken middleware has already verified the token
    // and attached the user object to req.user.
    const email = req.user?.email;

    if (!email) {
      console.error("❌ No email found in token for user:", req.user);
      // This is a safeguard; the middleware should prevent this.
      return res.status(400).json({ error: "Email not found in token." });
    }

    // Try to find user by id (new schema where id = email)
    let user = await prisma.user.findUnique({
      where: { id: email },
    });

    // If not found and we have old schema users, try alternative approach
    if (!user) {
      // Try to find by any field that might contain the email
      const users = await prisma.user.findMany();
      user = users.find(u => u.id === email || u.id.includes(email.split('@')[0]));
      
      if (!user) {
        console.error("❌ User not found in database for email:", email);
        return res.status(404).json({ error: "User has not registered for the event." });
      }
    }

    const hasUsername = !!user.username;

    res.status(200).json({ 
      ok: true, 
      hasUsername,
      user: {
        id: user.id,
        name: user.name, // Include the name
        username: user.username,
        role: user.role,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    console.error("Error in /verifyToken:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/set-username", verifyAuthToken, async (req, res) => {
  try {
    const email = req.user?.email;
    const { username } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email not found in token." });
    }

    if (!username || username.trim().length === 0) {
      return res.status(400).json({ error: "Username is required." });
    }

    // Check if username is already taken
    const existingUser = await prisma.user.findUnique({
      where: { username: username.trim() },
    });


    if (existingUser && existingUser.id !== email) {
      return res.status(409).json({ error: "Username is already taken." });
    }

    // Update the user's username
    const updatedUser = await prisma.user.update({
      where: { id: email }, 
      data: { username: username.trim() },
    });

    res.status(200).json({
      ok: true,
      message: "Username updated successfully.",
      user: { id: updatedUser.id, username: updatedUser.username }
    });
  } catch (error) {
    console.error("Error setting username:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});


export default router;
