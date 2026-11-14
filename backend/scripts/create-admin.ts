import { loadEnv } from "./load-env";

loadEnv();

/**
 * Creates (or promotes) a super admin account. Credentials must be supplied
 * explicitly via CLI args or env vars — there are no hidden/default admins.
 *
 *   npm run create-admin -- --email me@example.com --name "Me" --password "secret123"
 */
async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const index = args.indexOf(flag);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const email = (getArg("--email") ?? process.env.ADMIN_EMAIL ?? "").toLowerCase().trim();
  const name = getArg("--name") ?? process.env.ADMIN_NAME ?? "Super Admin";
  const password = getArg("--password") ?? process.env.ADMIN_PASSWORD ?? "";

  if (!email || !password) {
    console.error(
      "Usage: npm run create-admin -- --email <email> --name <name> --password <password>",
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const [{ dbConnect }, { User }, { hashPassword }] = await Promise.all([
    import("../lib/db"),
    import("../models/User"),
    import("../lib/auth/password"),
  ]);

  await dbConnect();

  const passwordHash = await hashPassword(password);
  const existing = await User.findOne({ email });

  if (existing) {
    existing.passwordHash = passwordHash;
    existing.platformRole = "super_admin";
    existing.active = true;
    if (name) existing.name = name;
    await existing.save();
    console.log(`Promoted existing user ${email} to super_admin.`);
  } else {
    await User.create({
      email,
      name,
      passwordHash,
      platformRole: "super_admin",
      active: true,
    });
    console.log(`Created super admin ${email}.`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("Failed:", error);
  process.exit(1);
});
