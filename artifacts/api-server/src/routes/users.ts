import { Router, type IRouter } from "express";
import { z } from "zod";
import { validateRequest } from "../middleware/validate.js";
import { requireRole } from "../middleware/auth.js";
import {
  APP_ROLES,
  UserManagementError,
  inviteUser,
  listUsers,
  updateUserRole,
} from "../services/user-management.js";

const UpdateRoleParams = z.object({ id: z.string().min(1) });
const UpdateRoleBody = z.object({ role: z.enum(APP_ROLES) }).strict();
const InviteUserBody = z
  .object({ email: z.string().trim().min(1).email(), role: z.enum(APP_ROLES) })
  .strict();

function userManagementErrorStatus(code: UserManagementError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "duplicate_email":
      return 409;
    default:
      return 400;
  }
}

const router: IRouter = Router();

router.get("/users", requireRole("admin"), async (_req, res): Promise<void> => {
  const users = await listUsers();
  res.json({ data: users });
});

router.post(
  "/users",
  requireRole("admin"),
  validateRequest({ body: InviteUserBody }),
  async (req, res): Promise<void> => {
    const { email, role } = req.body as { email: string; role: string };

    try {
      const created = await inviteUser(email, role);
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof UserManagementError) {
        res.status(userManagementErrorStatus(err.code)).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  },
);

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
