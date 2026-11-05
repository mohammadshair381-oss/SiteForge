import PublicPage from "@/components/marketing/PublicPage";

export default function PrivacyPolicyPage() {
  return (
    <PublicPage>
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-12 sm:py-20">
        <h1 className="text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
          Privacy Policy
        </h1>
        <p className="mt-4 text-lg text-slate-600">
          Last updated: October 2026
        </p>

        <p className="mt-8 text-sm text-slate-500">
          <strong>This Privacy Policy describes how SiteForge collects, uses, and
          protects information when you use our website builder service.</strong>
        </p>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">1. Information We Collect</h2>
          <h3 className="text-sm font-medium text-slate-700 mt-4 mb-2">
            Account information
          </h3>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            When you register, we collect your name, email address, and a hashed
            password. Your password is hashed with bcrypt and is never stored or
            returned in plaintext.
          </p>

          <h3 className="text-sm font-medium text-slate-700 mt-4 mb-2">
            Business and product information
          </h3>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            When you create a business, we collect the business name, subdomain,
            category, description, contact email, phone, address, currency, and
            theme settings. When you add products, we collect the product name,
            slug, description, price, currency, image URL, category, and stock.
          </p>

          <h3 className="text-sm font-medium text-slate-700 mt-4 mb-2">
            Authentication and session data
          </h3>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            We issue an HTTP-only JWT session cookie after successful login. The
            session includes your user ID, platform role, and a token version used
            for revocation. Password changes and logout invalidate existing sessions.
          </p>

          <h3 className="text-sm font-medium text-slate-700 mt-4 mb-2">
            Email verification and password-reset workflows
          </h3>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            We use your email address to send verification and password-reset links.
            These links contain single-use action tokens. Only a SHA-256 hash of
            each token is stored; the raw token is returned to you once and is never
            logged or persisted.
          </p>

          <h3 className="text-sm font-medium text-slate-700 mt-4 mb-2">
            Subscription and payment-related data
          </h3>
          <p className="text-slate-600 text-sm leading-relaxed">
            We store subscription status, plan reference, provider, and billing
            period start and end dates. Payment records include amount, currency,
            status, and a provider payment ID. We do not store full payment card
            numbers. Live payment processing is handled by a configured payment
            provider; sandbox/manual mode does not process live payments.
          </p>

          <h3 className="text-sm font-medium text-slate-700 mt-4 mb-2">
            Security and rate-limiting data
          </h3>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            We rate-limit authentication and password-reset endpoints. Client
            identifiers are HMAC-hashed before storage; raw IP addresses and emails
            are never stored in the database.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">2. How We Use Your Information</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            We use your information to:
          </p>
          <ul className="ml-6 list-disc space-y-1 text-sm text-slate-600">
            <li>Create and manage your account and business profile;</li>
            <li>Authenticate you and maintain your session;</li>
            <li>Send verification and password-reset emails;</li>
            <li>Render your public storefront and dashboard;</li>
            <li>Enforce subscription and product limits;</li>
            <li>Detect and prevent abuse through rate limiting;</li>
            <li>Operate and improve the SiteForge service.</li>
          </ul>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">3. Data Sharing</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            We do not sell your personal information. We may share information with:
          </p>
          <ul className="ml-6 list-disc space-y-1 text-sm text-slate-600">
            <li>
              Infrastructure providers that host and operate the SiteForge service;
            </li>
            <li>
              Email delivery providers used to send verification and password-reset
              messages;
            </li>
            <li>
              A configured payment provider, where applicable, for processing
              subscription payments.
            </li>
          </ul>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            Your public storefront content (business name, products, pricing, and
            contact information you choose to publish) is visible to visitors of
            your storefront subdomain.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">4. Cookies and Authentication Sessions</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            SiteForge uses an HTTP-only session cookie to maintain your
            authenticated session. This cookie is not accessible to JavaScript and
            is sent only over secure connections when configured appropriately. You
            can log out to invalidate your current session.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">5. Data Retention and Deletion</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            We retain account and business information as long as your account
            remains active. Product deletes are soft (archived); product data is
            preserved rather than permanently removed.
          </p>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            If you would like to request deletion of your account or data, contact
            SiteForge through the support channel made available in your dashboard.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">6. Your Privacy Rights</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            You may request access to, correction of, or deletion of your personal
            information by contacting SiteForge through your dashboard support
            channel. We will respond to verifiable requests in accordance with
            applicable law.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">7. Changes to This Policy</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            We may update this Privacy Policy from time to time. We will notify you
            of material changes by posting the updated policy on this page with a
            revised &ldquo;Last updated&rdquo; date. Your continued use of the
            service after changes are posted constitutes acceptance of the new
            policy.
          </p>
        </section>

        <section className="mt-10 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">8. Contact</h2>
          <p className="text-[0.9375rem] text-slate-600 leading-7">
            If you have questions about this Privacy Policy or about our data
            practices, contact SiteForge through the support channel made available
            in your dashboard.
          </p>
        </section>

        <section className="mt-12 border-t border-slate-200 pt-8">
          <p className="text-xs text-slate-500">
            <strong>Note:</strong> This Privacy Policy has not been reviewed by
            legal counsel and may not satisfy every applicable law. Please consult
            with a qualified attorney or privacy professional before using this
            document for a public commercial launch.
          </p>
        </section>
      </div>
    </PublicPage>
  );
}
