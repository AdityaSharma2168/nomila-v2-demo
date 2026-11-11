import { defineConfig } from "drizzle-kit";

// db:generate does not connect to the DB — a placeholder URL is fine:
//   DATABASE_URL=postgresql://localhost/nomila npm run db:generate
// db:migrate and db:push require a real DATABASE_URL.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set — use .env for local, Secret Manager for Cloud Run");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  migrations: {
    table: "__drizzle_migrations",
    schema: "public",
  },
});
