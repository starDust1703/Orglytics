import { neon } from "@neondatabase/serverless";
import { connection } from "next/server";
import { NextResponse } from "next/server";

import { getDatabaseUrl } from "@/lib/database";
import type { Organization, OrganizationsResponse } from "@/types/organization";

type OrganizationRow = Organization & { targetYear: number };

export async function GET() {
  await connection();

  const databaseUrl = getDatabaseUrl();

  if (!databaseUrl) {
    return NextResponse.json(
      { error: "DATABASE_URL is not configured for the backend." },
      { status: 500 },
    );
  }

  try {
    const sql = neon(databaseUrl);
    const rows = (await sql`
      SELECT
        organization AS name,
        description,
        tech AS technology,
        topic,
        website,
        gsoc_link AS "gsocLink",
        predicted_presence AS "predictedPresence",
        probability,
        model,
        target_year AS "targetYear"
      FROM gsoc_predictions
      WHERE target_year = (SELECT MAX(target_year) FROM gsoc_predictions)
      ORDER BY organization ASC
    `) as OrganizationRow[];

    const response: OrganizationsResponse = {
      organizations: rows.map(({ targetYear: _targetYear, ...organization }) => organization),
      targetYear: rows[0]?.targetYear ?? new Date().getFullYear(),
    };

    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to fetch organizations from Neon", error);
    return NextResponse.json(
      { error: "Unable to load organizations from the database." },
      { status: 500 },
    );
  }
}
