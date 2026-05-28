import rateLimit, { ipKeyGenerator } from "express-rate-limit";

export const generationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res): string => {
    const userId = (req.user as Express.User | undefined)?.id;
    return userId
      ? `user:${userId}`
      : `ip:${ipKeyGenerator(req.ip ?? "", res as unknown as Parameters<typeof ipKeyGenerator>[1])}`;
  },
  message: { error: "Too many generation requests, please wait before trying again." },
});
