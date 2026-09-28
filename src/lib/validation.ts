import 'server-only';
import { z } from 'zod';
// Email addresses are trimmed before validation so pasted values with stray
// spaces are accepted, then lowercased for consistent storage and lookup.
export const emailSchema = z
  .string()
  .trim()
  .pipe(z.email().transform((v) => v.toLowerCase()));
