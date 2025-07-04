import { Router } from "express";
import userRoutes from "./user.routes.js";
import testRoute from "./testRoute.js";
// import problemRoutes from "./problemRoutes.js";
// import submitRoutes from "./submit.js";
// import matchRoutes from './matchRoutes.js';

const router = Router();

// testing route
router.get("/", (req, res) => {
  res.json({ message: "API is working!" });
});

router.use("/user", userRoutes);
router.use("/test", testRoute);
// router.use("/problem", problemRoutes);
// router.use("/submission", submitRoutes);

export default router;
