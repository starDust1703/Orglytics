import Link from "next/link";
import { Suspense } from "react";

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
    <main className="min-h-screen bg-[#f8fafc] px-5 py-10 text-slate-950 sm:px-8 sm:py-14">
      <section className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-7 shadow-sm sm:p-10">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-700 hover:text-indigo-900"
        >
          <svg
            aria-hidden="true"
            className="size-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5m0 0 6-6m-6 6 6 6" />
          </svg>
          All organizations
        </Link>
        <p className="mt-10 text-sm font-semibold uppercase tracking-[0.18em] text-indigo-700">
          Organization profile
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">{organizationName}</h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-slate-600">
          This dedicated organization page is ready for its detailed profile, history,
          technologies, topics, and prediction explanation.
        </p>
      </section>
    </main>
  );
}
