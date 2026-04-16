/**
 * Landing page. Server component that redirects authenticated users
 * to dashboard, shows a simple landing for unauthenticated users.
 */
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buttonVariants } from "@/components/ui/button";

export default async function HomePage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (session) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <h1 className="mb-2 text-4xl font-bold">AI Video Studio</h1>
      <p className="mb-8 max-w-md text-center text-muted-foreground">
        One creator. One prompt. One published video. No camera, no face, no
        studio.
      </p>
      <div className="flex gap-3">
        <Link href="/signup" className={buttonVariants()}>
          Get started
        </Link>
        <Link href="/login" className={buttonVariants({ variant: "outline" })}>
          Sign in
        </Link>
      </div>
    </div>
  );
}
