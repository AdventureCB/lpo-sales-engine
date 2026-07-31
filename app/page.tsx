import { redirect } from "next/navigation";

/** Root: straight into the app (middleware handles the login bounce). */
export default function Home() {
  redirect("/scoreboard");
}
