-- Step 0.3: session version for revoking login sessions (logout, password change).

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "session_version" INTEGER NOT NULL DEFAULT 0;
