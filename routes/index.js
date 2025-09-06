import { Router } from "express";
import userRoutes from "./user.routes.js";
import submitRoutes from "./submit.routes.js";
import round0Routes from "./round0.routes.js";
import round1Routes from "./round1.routes.js";
import round2Routes from "./round2.routes.js";
import round3Routes from "./round3.routes.js";
import globalRoutes from "./global.routes.js";
import adminRoutes from "./admin.routes.js";

const router = Router();

// testing route
router.get("/", (req, res) => {
  res.json({ message: "API is working!" });
});

router.use("/user", userRoutes);
router.use("/submit", submitRoutes);
router.use("/r0",round0Routes);
router.use("/r1",round1Routes);
router.use("/r2",round2Routes);
router.use("/r3",round3Routes);
router.use("/event",globalRoutes);
router.use("/admin", adminRoutes);


export default router;
