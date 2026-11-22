import { redirect } from "next/navigation";

/** The app lives under /dashboard; the shell sends visitors without a session to /login. */
export default function Home() {
  redirect("/dashboard");
}
