import { Router } from "express";
import userRoutes from "./user.routes.js";

const router = Router();

// testing route
router.get("/", (req, res) => {
  res.json({ message: "API is working!" });
});

router.use("/user", userRoutes);

export default router;
