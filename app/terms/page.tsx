import PublicPage from "@/components/marketing/PublicPage";

export default function TermsOfServicePage() {
  return (
    <PublicPage>
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-12 sm:py-20">
        <h1 className="text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
          Terms of Service
        </h1>
        <p className="mt-4 text-lg text-slate-600">
          Last updated: October 2026
        </p>

        <p className="mt-8 text-sm text-slate-500">
          <strong>Please read these terms carefully before using SiteForge.</strong>
        </p>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">1. Acceptance of Terms</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            By accessing or using SiteForge (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or
            &ldquo;our&rdquo;), you agree to be bound by these Terms of Service. If
            you do not agree, you may not use the service.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">2. Description of Service</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            SiteForge is a multi-tenant website builder that lets business owners
            create a business profile, add products, choose from nine themes, and
            publish a storefront on a platform subdomain. A platform admin panel
            manages businesses and plans.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">3. User Accounts</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            To use SiteForge, you must register an account with a valid email
            address and password. You are responsible for maintaining the
            confidentiality of your account credentials and for all activity under
            your account.
          </p>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            We send a verification email to the address you provide during
            registration. You must verify your email before certain actions, such as
            creating a business or publishing a storefront, are available.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">4. Business-Owner Responsibilities</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            As a business owner, you are responsible for the accuracy and
            appropriateness of all business information, product listings, and
            storefront content you publish through SiteForge.
          </p>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            You may invite staff members to your business and assign them owner or
            staff roles. You remain accountable for actions taken by members of
            your team.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">5. Acceptable Use</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            You may not use SiteForge to:
          </p>
          <ul className="ml-6 list-disc space-y-1 text-sm text-slate-600">
            <li>Publish unlawful, harmful, or abusive content;</li>
            <li>Infringe on any intellectual property rights;</li>
            <li>Misrepresent your affiliation with any person or entity;</li>
            <li>Attempt to disrupt, reverse-engineer, or gain unauthorized access to the service;</li>
            <li>Use the service for any purpose that violates applicable law.</li>
          </ul>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">6. Subscription and Billing</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            SiteForge offers subscription plans with different product and staff
            limits. Plan details, including pricing and billing interval
            (monthly or yearly), are presented on the SiteForge website and in the
            dashboard billing page.
          </p>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            Paid plans require activation through the configured payment provider.
            In sandbox/manual mode, plan activation may occur immediately on the
            server without live payment processing.
          </p>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            If your paid subscription period ends and is not renewed, your storefront
            may become inaccessible until the subscription is active again. Free
            plans remain accessible regardless of the subscription period end.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">7. Suspension and Termination</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            We may suspend or terminate your account or business at our discretion,
            including for violations of these Terms. A suspended business cannot be
            published or unpublished by its owner until a platform administrator
            changes its status.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">8. Service Availability and Limitations</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            SiteForge is provided on an &ldquo;as is&rdquo; and &ldquo;as
            available&rdquo; basis. We do not guarantee that the service will be
            error-free, uninterrupted, or free from defects.
          </p>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            Custom domains can be added on plans that include them. Ownership is
            verified with a DNS TXT record before a custom domain serves your
            storefront. You are responsible for pointing the domain at SiteForge
            and for its DNS records; configuring A/CNAME records and obtaining
            TLS certificates are not automated by the platform.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">9. Intellectual Property</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            You retain ownership of the business information, product listings, and
            other content you submit to SiteForge. By publishing content through
            SiteForge, you grant SiteForge a license to host, display, and serve
            that content on your storefront.
          </p>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            The SiteForge platform, themes, name, and logo are owned by SiteForge
            or its licensors. You may not use SiteForge branding without explicit
            permission, except as permitted by your subscription plan (such as the
            removeBranding entitlement where applicable).
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">10. Third-Party Services</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            SiteForge may use third-party infrastructure and service providers,
            including email delivery providers, to operate the service. Your use of
            the service is subject to those providers&rsquo; terms as well as these
            Terms.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">11. Changes to These Terms</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            We may update these Terms of Service from time to time. We will notify
            you of material changes by posting the updated terms on this page with a
            revised &ldquo;Last updated&rdquo; date. Your continued use of the
            service after changes are posted constitutes acceptance of the new
            terms.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">12. Contact</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            If you have questions about these Terms of Service, contact SiteForge
            through the support channel made available in your dashboard.
          </p>
        </section>

        <section className="mt-12 border-t border-slate-200 pt-8">
          <p className="text-xs text-slate-500">
            <strong>Note:</strong> These Terms of Service have not been reviewed by
            legal counsel. Please consult with a qualified attorney before using
            this document for a public commercial launch.
          </p>
        </section>
      </div>
    </PublicPage>
  );
}
