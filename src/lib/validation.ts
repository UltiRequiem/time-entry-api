import type { Context } from "hono";

// Returns a consistent { error, issues } envelope instead of the default
// stringified ZodError blob. Pass as the third arg to every zValidator call.
export const validationHook = (
  result: {
    success: boolean;
    // Zod v4 uses PropertyKey[] (string | number | symbol) for issue paths.
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  },
  c: Context,
) => {
  if (!result.success) {
    return c.json(
      {
        error: "invalid request",
        issues: result.error!.issues.map((i) => ({
          ...(i.path.length && { path: i.path.map(String).join(".") }),
          message: i.message,
        })),
      },
      400,
    );
  }
};
