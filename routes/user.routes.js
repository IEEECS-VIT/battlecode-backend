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
      // This is a safeguard; the middleware should prevent this.
      return res.status(400).json({ error: "Email not found in token." });
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return res.status(404).json({ error: "User has not registered for the event." });
    }

    const hasUsername = !!user.username;

    res.status(200).json({ ok: true, hasUsername });
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

    if (existingUser && existingUser.email !== email) {
      return res.status(409).json({ error: "Username is already taken." });
    }

    // Update the user's username
    const updatedUser = await prisma.user.update({
      where: { email },
      data: { username: username.trim() },
    });

    res.status(200).json({ 
      ok: true, 
      message: "Username updated successfully.",
      user: { email: updatedUser.email, username: updatedUser.username }
    });
  } catch (error) {
    console.error("Error setting username:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
