"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import type { Organization } from "@/types/organization";

const PAGE_SIZE = 50;

type SortKey = "name" | "probability";
type SortDirection = "asc" | "desc";

const sortOptions: { key: SortKey; label: string }[] = [
  { key: "name", label: "Organization name" },
  { key: "probability", label: "Prediction probability" },
];

type IconName =
  | "arrow-down"
  | "arrow-right"
  | "arrow-up"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "chevrons-left"
  | "chevrons-right";

function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    "arrow-down": <path d="M12 5v14m0 0 5-5m-5 5-5-5" />,
    "arrow-right": <path d="M5 12h14m0 0-5-5m5 5-5 5" />,
    "arrow-up": <path d="M12 19V5m0 0L7 10m5-5 5 5" />,
    "chevron-down": <path d="m6 9 6 6 6-6" />,
    "chevron-left": <path d="m15 18-6-6 6-6" />,
    "chevron-right": <path d="m9 18 6-6-6-6" />,
    "chevrons-left": <path d="m11 17-5-5 5-5m7 10-5-5 5-5" />,
    "chevrons-right": <path d="m13 17 5-5-5-5M6 17l5-5-5-5" />,
  };

  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function tags(value: string) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 4);
}

export default function OrganizationBrowser() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [targetYear, setTargetYear] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("probability");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 20_000);
    let mounted = true;

    async function loadOrganizations() {
      try {
        const response = await fetch("/api/organizations", {
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error("Unable to load organizations.");
        }

        const data = (await response.json()) as {
          organizations: Organization[];
          targetYear: number;
        };

        if (mounted) {
          setOrganizations(data.organizations);
          setTargetYear(data.targetYear);
          setError(null);
        }
      } catch (fetchError: unknown) {
        if (!mounted) {
          return;
        }

        if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
          setError("The database took too long to respond. Please try again.");
          return;
        }
        setError("We couldn’t load the organization forecasts. Please try again.");
      } finally {
        window.clearTimeout(timeoutId);
        if (mounted) {
          setLoading(false);
        }
      }
    }

    void loadOrganizations();

    return () => {
      mounted = false;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  const sortedOrganizations = useMemo(() => {
    const multiplier = direction === "asc" ? 1 : -1;
    return [...organizations].sort((left, right) => {
      let result = 0;

      if (sortKey === "name") {
        result = compareText(left.name, right.name);
      } else if (sortKey === "probability") {
        result = left.probability - right.probability;
      }

      return result === 0 ? compareText(left.name, right.name) : result * multiplier;
    });
  }, [direction, organizations, sortKey]);

  if (loading) {
    return (
      <main className="min-h-screen bg-[#f8fafc] text-slate-950">
        <section className="mx-auto w-full max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
          <div className="mb-9 flex flex-col gap-6 border-b border-slate-200 pb-8 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-2xl">
              <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-indigo-700">
                Orglytics
              </p>
              <h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                GSoC organization forecast
              </h1>
              <p className="mt-4 text-base leading-7 text-slate-600">
                Preparing the latest organization forecasts for you.
              </p>
            </div>
            <div className="h-[68px] w-64 animate-pulse rounded-xl border border-slate-200 bg-white shadow-sm" />
          </div>

          <div
            role="status"
            aria-live="polite"
            className="mb-6 flex items-center gap-3 rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-sm text-indigo-900"
          >
            <span
              aria-hidden="true"
              className="size-5 shrink-0 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600"
            />
            <span>
              <span className="font-semibold">Loading forecasts</span>
              <span className="text-indigo-800/75"> — connecting to the latest data</span>
            </span>
          </div>

          <div className="mb-6 flex items-center justify-between text-sm text-slate-400">
            <div className="h-5 w-56 animate-pulse rounded-md bg-slate-200" />
            <div className="h-5 w-20 animate-pulse rounded-md bg-slate-200" />
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={index}
                className="min-h-72 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="h-6 w-3/5 animate-pulse rounded-md bg-slate-200" />
                  <div className="h-6 w-16 animate-pulse rounded-full bg-slate-200" />
                </div>
                <div className="mt-5 space-y-2">
                  <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
                  <div className="h-3 w-11/12 animate-pulse rounded bg-slate-100" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-slate-100" />
                </div>
                <div className="mt-6 flex items-end justify-between border-y border-slate-100 py-4">
                  <div>
                    <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
                    <div className="mt-2 h-8 w-20 animate-pulse rounded-md bg-slate-200" />
                  </div>
                  <div className="h-4 w-28 animate-pulse rounded bg-slate-100" />
                </div>
                <div className="mt-5 flex gap-2">
                  <div className="h-6 w-16 animate-pulse rounded-md bg-slate-100" />
                  <div className="h-6 w-20 animate-pulse rounded-md bg-slate-100" />
                  <div className="h-6 w-14 animate-pulse rounded-md bg-slate-100" />
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    );
  }

  if (error || targetYear === null || organizations.length === 0) {
    return (
      <main className="min-h-screen bg-[#f8fafc] text-slate-950">
        <section className="mx-auto w-full max-w-2xl px-5 py-20 text-center sm:px-8">
          <h1 className="text-2xl font-semibold">Unable to load forecasts</h1>
          <p className="mt-3 text-slate-600">
            {error ?? "No forecast data is available."}
          </p>
        </section>
      </main>
    );
  }

  const totalPages = Math.max(1, Math.ceil(sortedOrganizations.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const visibleOrganizations = sortedOrganizations.slice(pageStart, pageStart + PAGE_SIZE);
  const activeSort = sortOptions.find((option) => option.key === sortKey) ?? sortOptions[0];

  function chooseSort(nextSortKey: SortKey) {
    if (nextSortKey === sortKey) {
      setDirection((currentDirection) =>
        currentDirection === "asc" ? "desc" : "asc",
      );
    } else {
      setSortKey(nextSortKey);
    }

    setPage(1);
  }

  function goToPage(nextPage: number) {
    setPage(Math.min(Math.max(nextPage, 1), totalPages));
  }

  return (
    <main className="min-h-screen bg-[#f8fafc] text-slate-950">
      <section className="mx-auto w-full max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
        <div className="mb-9 flex flex-col gap-6 border-b border-slate-200 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <p className="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-indigo-700">
              Orglytics
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              GSoC {targetYear} organization forecast
            </h1>
            <p className="mt-4 text-base leading-7 text-slate-600">
              {organizations.length.toLocaleString()} organizations ranked by their predicted
              presence in Google Summer of Code {targetYear}.
            </p>
          </div>

          <div className="group relative shrink-0">
            <button
              type="button"
              aria-controls="sort-options"
              aria-haspopup="true"
              className="flex min-w-64 items-center justify-between gap-4 rounded-xl border border-slate-300 bg-white px-4 py-3 text-left text-sm font-medium shadow-sm transition hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2"
            >
              <span>
                <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                  Sort by
                </span>
                <span className="mt-1 flex items-center gap-2 text-slate-950">
                  {activeSort.label}
                  <span
                    aria-label={direction === "asc" ? "ascending" : "descending"}
                    className="inline-flex"
                  >
                    <Icon name={direction === "asc" ? "arrow-up" : "arrow-down"} />
                  </span>
                </span>
              </span>
              <span aria-hidden="true" className="text-slate-500 transition-transform duration-200 group-hover:rotate-180">
                <Icon name="chevron-down" />
              </span>
            </button>

            <div
              id="sort-options"
              className="pointer-events-none invisible absolute right-0 z-10 mt-0 w-full translate-y-1 overflow-hidden rounded-xl border border-slate-200 bg-white p-1 opacity-0 shadow-xl transition-all duration-200 ease-out group-hover:pointer-events-auto group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100"
            >
              {sortOptions.map((option) => {
                const isActive = option.key === sortKey;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => chooseSort(option.key)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm transition ${
                      isActive
                        ? "bg-indigo-50 font-semibold text-indigo-800"
                        : "text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <span>{option.label}</span>
                    {isActive ? (
                      <span
                        aria-label={direction === "asc" ? "ascending" : "descending"}
                        className="inline-flex"
                      >
                        <Icon name={direction === "asc" ? "arrow-up" : "arrow-down"} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mb-6 flex flex-col gap-2 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Showing {visibleOrganizations.length ? pageStart + 1 : 0}–
            {Math.min(pageStart + PAGE_SIZE, sortedOrganizations.length)} of{" "}
            {sortedOrganizations.length.toLocaleString()} organizations
          </p>
          <p>
            Page {safePage} of {totalPages}
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleOrganizations.map((organization) => (
            <Link
              key={organization.name}
              href={`/${encodeURIComponent(organization.name)}`}
              className="group flex min-h-72 flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2"
            >
              <div className="flex items-start justify-between gap-4">
                <h2 className="text-lg font-semibold leading-6 text-slate-950 group-hover:text-indigo-700">
                  {organization.name}
                </h2>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                    organization.predictedPresence
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {organization.predictedPresence ? "Likely" : "Unlikely"}
                </span>
              </div>

              <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-600">
                {organization.description || "No organization description is available."}
              </p>

              <div className="mt-5 flex items-end justify-between border-y border-slate-100 py-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    {targetYear} probability
                  </p>
                  <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
                    {(organization.probability * 100).toFixed(1)}%
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 text-sm font-medium text-indigo-700">
                  View organization
                  <Icon name="arrow-right" className="size-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>

              <div className="mt-5">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                  Technologies
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {tags(organization.technology).length ? (
                    tags(organization.technology).map((technology) => (
                      <span
                        key={technology}
                        className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700"
                      >
                        {technology}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-slate-500">Not specified</span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>

        <nav aria-label="Organization pages" className="mt-10 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => goToPage(1)}
            disabled={safePage === 1}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span className="inline-flex items-center gap-1.5">
              <Icon name="chevrons-left" />
              First
            </span>
          </button>
          <button
            type="button"
            onClick={() => goToPage(safePage - 1)}
            disabled={safePage === 1}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span className="inline-flex items-center gap-1.5">
              <Icon name="chevron-left" />
              Previous
            </span>
          </button>
          <span className="px-2 text-sm text-slate-600">
            {safePage} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => goToPage(safePage + 1)}
            disabled={safePage === totalPages}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span className="inline-flex items-center gap-1.5">
              Next
              <Icon name="chevron-right" />
            </span>
          </button>
          <button
            type="button"
            onClick={() => goToPage(totalPages)}
            disabled={safePage === totalPages}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span className="inline-flex items-center gap-1.5">
              Last
              <Icon name="chevrons-right" />
            </span>
          </button>
        </nav>
      </section>
    </main>
  );
}
