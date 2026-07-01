import { Router, type IRouter } from "express";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import {
  APP_ROLES,
  UserManagementError,
  listUsers,
  updateUserRole,
} from "../services/user-management.js";

const UpdateRoleParams = z.object({ id: z.string().min(1) });
const UpdateRoleBody = z.object({ role: z.enum(APP_ROLES) }).strict();

const router: IRouter = Router();

router.get("/users", requireRole("admin"), async (_req, res): Promise<void> => {
  const users = await listUsers();
  res.json({ data: users });
});

router.patch(
  "/users/:id/role",
  requireRole("admin"),
  validateRequest({ params: UpdateRoleParams, body: UpdateRoleBody }),
  async (req, res): Promise<void> => {
    const { id } = req.params as { id: string };
    const { role } = req.body as { role: string };

    try {
      const updated = await updateUserRole(id, role);
      res.json(updated);
    } catch (err) {
      if (err instanceof UserManagementError) {
        const status = err.code === "not_found" ? 404 : 400;
        res.status(status).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  },
);

export default router;
