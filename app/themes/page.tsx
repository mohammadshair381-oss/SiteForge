import type { Metadata } from "next";
import { getSession } from "@/lib/auth/session";
import { THEMES } from "@/lib/themes";
import PublicPage from "@/components/marketing/PublicPage";
import ThemeGallery from "@/components/marketing/ThemeGallery";
import { loadPublicPlans, themePlanNames } from "@/components/marketing/plans";
import { Eyebrow } from "@/components/ui/Surface";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Themes | SiteForge",
  description: "Nine complete store designs, each with its own layouts, type and motion. Preview any of them on desktop, tablet and phone.",
};

export default async function ThemesPage() {
  const [plans, session] = await Promise.all([loadPublicPlans(), getSession()]);
  const authed = Boolean(session);
  return (
    <PublicPage authed={authed}>
      <section className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20">
          <Eyebrow>Themes</Eyebrow>
          <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight [text-wrap:balance] sm:text-6xl">Find the design that feels like your business</h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
            {THEMES.length} complete store designs, not {THEMES.length} colour swaps. Open any of them to see it on desktop, tablet and phone. Switching later never touches your products or pages.
          </p>
        </div>
      </section>
      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
        <ThemeGallery planNames={themePlanNames(plans)} signUpHref={authed ? "/dashboard" : "/register"} />
      </section>
    </PublicPage>
  );
}
