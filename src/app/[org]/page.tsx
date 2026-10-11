import { Suspense } from "react";

import OrganizationProfile from "@/components/organization-profile";

type OrganizationPageProps = {
  params: Promise<{ org: string }>;
};

export default function OrganizationPage({
  params,
}: OrganizationPageProps) {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-[#f8fafc] px-5 py-10 text-slate-950 sm:px-8 sm:py-14">
          <section className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-7 shadow-sm sm:p-10">
            <p className="text-sm font-semibold text-slate-500">Loading organization…</p>
          </section>
        </main>
      }
    >
      <OrganizationContent params={params} />
    </Suspense>
  );
}

async function OrganizationContent({ params }: OrganizationPageProps) {
  const { org } = await params;
  let organizationName = org;

  try {
    organizationName = decodeURIComponent(org);
  } catch {
    // Keep the raw segment visible if a malformed URL is requested.
  }

  return (
    <OrganizationProfile key={organizationName} organizationName={organizationName} />
  );
}
