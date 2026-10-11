"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

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
  | "chevrons-right"
  | "search";

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
    search: <path d="m21 21-4.35-4.35m1.35-5.65a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />,
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

function values(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  emptyLabel,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (nextValues: string[]) => void;
  emptyLabel: string;
}) {
  const summary = selected.length
    ? `${selected.length} selected`
    : emptyLabel;
  const dropdownRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function closeOnOutsideClick(event: PointerEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        dropdownRef.current.open = false;
      }
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  return (
    <details ref={dropdownRef} className="group relative flex-1 text-sm font-medium text-slate-700">
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl border border-slate-300 bg-white px-3 py-3 outline-none transition hover:border-slate-400 focus-visible:ring-2 focus-visible:ring-indigo-600/20 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            {label}
          </span>
          <span className={selected.length ? "text-slate-950" : "text-slate-500"}>
            {summary}
          </span>
        </span>
        <Icon
          name="chevron-down"
          className="size-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
        />
      </summary>

      <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-2 pb-2">
          <span className="text-xs text-slate-500">
            {selected.length ? `${selected.length} selected` : "Select any"}
          </span>
          {selected.length ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-xs font-semibold text-indigo-700 hover:text-indigo-900"
            >
              Clear
            </button>
          ) : null}
        </div>
        <div className="max-h-64 overflow-y-auto pt-1">
          {options.length ? (
            options.map((option) => {
              const isSelected = selected.includes(option);
              return (
                <label
                  key={option}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-slate-700 transition hover:bg-indigo-50 hover:text-indigo-900"
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => {
                      onChange(
                        isSelected
                          ? selected.filter((value) => value !== option)
                          : [...selected, option],
                      );
                    }}
                    className="size-4 rounded border-slate-300 accent-indigo-600"
                  />
                  <span className="truncate">{option}</span>
                </label>
              );
            })
          ) : (
            <p className="px-2 py-3 text-sm text-slate-500">No options available.</p>
          )}
        </div>
      </div>
    </details>
  );
}

export default function OrganizationBrowser() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [targetYear, setTargetYear] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("probability");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [searchQuery, setSearchQuery] = useState("");
  const [technologyFilters, setTechnologyFilters] = useState<string[]>([]);
  const [yearFilters, setYearFilters] = useState<string[]>([]);
  const [minimumProbability, setMinimumProbability] = useState(0);
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

  const technologyOptions = useMemo(() => {
    return Array.from(
      new Set(organizations.flatMap((organization) => values(organization.technology))),
    ).sort(compareText);
  }, [organizations]);

  const yearOptions = useMemo(() => {
    return Array.from(
      new Set(organizations.flatMap((organization) => values(organization.years))),
    ).sort((left, right) => Number(right) - Number(left));
  }, [organizations]);

  const filteredOrganizations = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return organizations.filter((organization) =>
      (!query || organization.name.toLocaleLowerCase().includes(query)) &&
      (!technologyFilters.length || technologyFilters.some((technology) => values(organization.technology).includes(technology))) &&
      (!yearFilters.length || yearFilters.some((year) => values(organization.years).includes(year))) &&
      organization.probability >= minimumProbability,
    );
  }, [minimumProbability, organizations, searchQuery, technologyFilters, yearFilters]);

  const sortedOrganizations = useMemo(() => {
    const multiplier = direction === "asc" ? 1 : -1;
    return [...filteredOrganizations].sort((left, right) => {
      let result = 0;

      if (sortKey === "name") {
        result = compareText(left.name, right.name);
      } else if (sortKey === "probability") {
        result = left.probability - right.probability;
      }

      return result === 0 ? compareText(left.name, right.name) : result * multiplier;
    });
  }, [direction, filteredOrganizations, sortKey]);

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

        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="relative block w-full sm:max-w-md">
            <span className="sr-only">Search organizations by name</span>
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
              <Icon name="search" className="size-5" />
            </span>
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Search organizations"
              className="w-full rounded-xl border border-slate-300 bg-white py-3 pl-10 pr-4 text-sm text-slate-950 shadow-sm outline-none transition placeholder:text-slate-400 hover:border-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-600/20"
            />
          </label>
          {searchQuery ? (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                setPage(1);
              }}
              className="self-start text-sm font-semibold text-indigo-700 transition hover:text-indigo-900 sm:self-auto"
            >
              Clear search
            </button>
          ) : null}
        </div>

        <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
            <MultiSelectDropdown
              label="Technology"
              options={technologyOptions}
              selected={technologyFilters}
              onChange={(nextValues) => {
                setTechnologyFilters(nextValues);
                setPage(1);
              }}
              emptyLabel="All technologies"
            />

            <MultiSelectDropdown
              label="Participation year"
              options={yearOptions}
              selected={yearFilters}
              onChange={(nextValues) => {
                setYearFilters(nextValues);
                setPage(1);
              }}
              emptyLabel="All years"
            />

            <label className="flex-1 text-sm font-medium text-slate-700 lg:min-w-72">
              <span className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
                <span>Minimum probability</span>
                <span className="text-indigo-700">{Math.round(minimumProbability * 100)}%+</span>
              </span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={minimumProbability}
                onChange={(event) => {
                  setMinimumProbability(Number(event.target.value));
                  setPage(1);
                }}
                aria-label="Minimum predicted probability"
                className="mt-2 w-full accent-indigo-600"
              />
              <span className="mt-1 flex justify-between text-xs text-slate-400">
                <span>0%</span>
                <span>100%</span>
              </span>
            </label>
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

        {visibleOrganizations.length ? (
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
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center shadow-sm">
            <h2 className="text-lg font-semibold text-slate-950">No organizations found</h2>
            <p className="mt-2 text-sm text-slate-600">
              No organization title matches “{searchQuery}”.
            </p>
          </div>
        )}

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
