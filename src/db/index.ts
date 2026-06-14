import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import { env } from "../lib/env";
import * as schema from "./schema";

const client = createClient({ url: env.DB_FILE_NAME });

// SQLite does not enforce FK constraints by default — this must be set per connection.
await client.execute("PRAGMA foreign_keys = ON");

export const db = drizzle(client, { schema });
export { schema };
