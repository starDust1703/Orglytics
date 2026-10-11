"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { Organization, OrganizationsResponse } from "@/types/organization";

function splitValues(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ArrowIcon({ direction }: { direction: "left" | "right" }) {
  return (
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
      <path
        d={direction === "left" ? "M19 12H5m0 0 6-6m-6 6 6 6" : "M5 12h14m0 0-5-5m5 5-5 5"}
      />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 transition-transform group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 5h5v5" />
      <path d="m19 5-8 8" />
      <path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function StatusIcon({ present }: { present: boolean | null }) {
  if (present === true) {
    return (
      <svg aria-hidden="true" className="size-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m5 12 4 4L19 6" />
      </svg>
    );
  }

  if (present === false) {
    return (
      <svg aria-hidden="true" className="size-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <path d="m7 7 10 10M17 7 7 17" />
      </svg>
    );
  }

  return <span aria-hidden="true" className="text-xl font-semibold">—</span>;
}

function DetailCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <div className="mt-3 text-sm leading-6 text-slate-700">{children}</div>
    </div>
  );
}

export default function OrganizationProfile({ organizationName }: { organizationName: string }) {
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [targetYear, setTargetYear] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "success" | "empty" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);

    fetch(`/api/organizations?name=${encodeURIComponent(organizationName)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Unable to load organization.");
        }
        return response.json() as Promise<OrganizationsResponse>;
      })
      .then((data) => {
        const nextOrganization = data.organizations[0] ?? null;
        setOrganization(nextOrganization);
        setTargetYear(data.targetYear);
        setStatus(nextOrganization ? "success" : "empty");
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") {
          if (!timedOut) {
            return;
          }
          setError("The database request took too long. Please try again.");
          setStatus("error");
          return;
        }
        setError("We couldn’t load this organization’s details.");
        setStatus("error");
      })
      .finally(() => window.clearTimeout(timeoutId));

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [organizationName]);

  if (status === "loading") {
    return (
      <main className="min-h-screen bg-[#f8fafc] px-5 py-10 text-slate-950 sm:px-8 sm:py-14">
        <section className="mx-auto max-w-5xl">
          <div className="h-5 w-36 animate-pulse rounded bg-slate-200" />
          <div className="mt-10 h-12 w-3/4 animate-pulse rounded-xl bg-slate-200" />
          <div className="mt-4 h-5 w-1/2 animate-pulse rounded bg-slate-100" />
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="h-32 animate-pulse rounded-2xl bg-white shadow-sm" />
            ))}
          </div>
        </section>
      </main>
    );
  }

  if (status !== "success" || !organization || targetYear === null) {
    return (
      <main className="min-h-screen bg-[#f8fafc] px-5 py-10 text-slate-950 sm:px-8 sm:py-14">
        <section className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-7 shadow-sm sm:p-10">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-700 hover:text-indigo-900">
            <ArrowIcon direction="left" />
            All organizations
          </Link>
          <h1 className="mt-10 text-2xl font-semibold">Organization not available</h1>
          <p className="mt-3 text-slate-600">{error ?? "No details were found for this organization."}</p>
        </section>
      </main>
    );
  }

  const technologies = splitValues(organization.technology);
  const topics = splitValues(organization.topic);
  const years = splitValues(organization.years);
  const participation = [
    { year: targetYear - 1, present: organization.t1 ?? (years.includes(String(targetYear - 1)) ? true : null) },
    { year: targetYear - 2, present: organization.t2 ?? (years.includes(String(targetYear - 2)) ? true : null) },
    { year: targetYear - 3, present: organization.t3 ?? (years.includes(String(targetYear - 3)) ? true : null) },
    { year: targetYear - 4, present: organization.t4 ?? (years.includes(String(targetYear - 4)) ? true : null) },
    { year: targetYear - 5, present: organization.t5 ?? (years.includes(String(targetYear - 5)) ? true : null) },
  ];

  return (
    <main className="min-h-screen bg-[#f8fafc] px-5 py-10 text-slate-950 sm:px-8 sm:py-14">
      <section className="mx-auto max-w-5xl">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-700 hover:text-indigo-900">
          <ArrowIcon direction="left" />
          All organizations
        </Link>

        <div className="mt-10 flex flex-col gap-5 border-b border-slate-200 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-indigo-700">Organization profile</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">{organization.name}</h1>
          </div>
          <span className={`w-fit rounded-full px-3 py-1.5 text-sm font-semibold ${organization.predictedPresence ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"}`}>
            {organization.predictedPresence ? `Likely in ${targetYear}` : `Unlikely in ${targetYear}`}
          </span>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <DetailCard label={`${targetYear} probability`}>
            <p className="text-3xl font-semibold tracking-tight text-slate-950">{(organization.probability * 100).toFixed(1)}%</p>
          </DetailCard>
          <DetailCard label="Participation history">
            <div className="flex flex-wrap gap-3">
              {participation.map(({ year, present }) => (
                <div key={year} className="flex min-w-12 flex-col items-center gap-2">
                  <div
                    aria-label={`${year}: ${present === true ? "Yes" : present === false ? "No" : "Unknown"}`}
                    className={`flex size-12 items-center justify-center rounded-lg text-white shadow-sm ${
                      present === true ? "bg-emerald-500" : present === false ? "bg-rose-500" : "bg-slate-300 text-slate-700"
                    }`}
                  >
                    <StatusIcon present={present} />
                  </div>
                  <span className="text-xs font-medium text-slate-600">{year}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-xs font-medium text-slate-600">
              <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-emerald-500" />Yes</span>
              <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-rose-500" />No</span>
              <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-slate-300" />Unknown</span>
            </div>
          </DetailCard>
          <DetailCard label="Links">
            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1">
              {organization.website ? <a href={organization.website} target="_blank" rel="noreferrer" className="group/link inline-flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 font-semibold text-slate-800 transition hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-800 hover:shadow-sm"><span>Visit website</span><ExternalLinkIcon /></a> : null}
              {organization.gsocLink ? <a href={organization.gsocLink} target="_blank" rel="noreferrer" className="group/link inline-flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 font-semibold text-slate-800 transition hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-800 hover:shadow-sm"><span>Open GSoC page</span><ExternalLinkIcon /></a> : null}
              {organization.contributorGuidance ? <a href={organization.contributorGuidance} target="_blank" rel="noreferrer" className="group/link inline-flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 font-semibold text-slate-800 transition hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-800 hover:shadow-sm"><span>Contributor guidance</span><ExternalLinkIcon /></a> : null}
              {!organization.website && !organization.gsocLink && !organization.contributorGuidance ? <span>Not available</span> : null}
            </div>
          </DetailCard>
        </div>

        <div className="mt-4">
          <DetailCard label="Description">
            <p className="whitespace-pre-line">{organization.longDescription || organization.description || "No description is available."}</p>
            <div className="mt-6 grid gap-5 border-t border-slate-100 pt-5 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Technologies</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {technologies.length ? technologies.map((technology) => <span key={technology} className="rounded-full bg-indigo-50 px-2.5 py-1 text-indigo-800">{technology}</span>) : <span>Not available</span>}
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Topics</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {topics.length ? topics.map((topic) => <span key={topic} className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">{topic}</span>) : <span>Not available</span>}
                </div>
              </div>
            </div>
          </DetailCard>
        </div>
      </section>
    </main>
  );
}
