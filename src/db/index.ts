import { drizzle } from "drizzle-orm/libsql";
import { env } from "../lib/env";
import * as schema from "./schema";

export const db = drizzle(env.DB_FILE_NAME, { schema });
