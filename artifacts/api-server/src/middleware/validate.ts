import type { Request, Response, NextFunction } from "express";
import { type ZodSchema, type ZodError } from "zod";

interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export function validateRequest(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: Array<{ location: string; issues: ZodError["issues"] }> = [];

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        errors.push({ location: "body", issues: result.error.issues });
      } else {
        req.body = result.data;
      }
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        errors.push({ location: "query", issues: result.error.issues });
      } else {
        (req as unknown as Record<string, unknown>).query = result.data;
      }
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        errors.push({ location: "params", issues: result.error.issues });
      } else {
        (req as unknown as Record<string, unknown>).params = result.data;
      }
    }

    if (errors.length > 0) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        details: errors.flatMap(e =>
          e.issues.map(i => ({ ...i, location: e.location }))
        ),
      });
      return;
    }

    next();
  };
}
