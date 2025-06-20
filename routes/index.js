import { Router } from "express";
import userRoutes from "./user.routes.js";
import testRoute from './testRoute.js';
import matchRoutes from './matchRoutes.js';

const router = Router();

// testing route
router.get("/", (req, res) => {
  res.json({ message: "API is working!" });
});

router.use("/user", userRoutes);
router.use('/test', testRoute);
router.use('/match',matchRoutes)

export default router;
