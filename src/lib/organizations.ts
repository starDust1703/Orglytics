import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

export type Organization = {
  name: string;
  description: string;
  technology: string;
  topic: string;
  website: string;
  gsocLink: string;
  predictedPresence: boolean;
  probability: number;
  model: string;
};

function parseCsv(contents: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    const nextCharacter = contents[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  row.push(cell);
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }
  return rows;
}

function recordFromRow(headers: string[], row: string[]) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
}

export async function getOrganizations(): Promise<{
  organizations: Organization[];
  targetYear: number;
}> {
  "use cache";

  const csvPath = path.join(process.cwd(), "src", "backend", "gsoc_t_year_predictions.csv");
  const csv = await readFile(csvPath, "utf8");
  const [headers = [], ...dataRows] = parseCsv(csv);
  const predictionHeader = headers.find((header) => /^Predicted \d{4}$/.test(header));

  if (!predictionHeader) {
    throw new Error("The prediction CSV must include a 'Predicted YYYY' column.");
  }

  const targetYear = Number(predictionHeader.replace("Predicted ", ""));
  const probabilityHeader = `Probability ${targetYear}`;

  if (!headers.includes(probabilityHeader)) {
    throw new Error(`The prediction CSV must include '${probabilityHeader}'.`);
  }

  const organizations = dataRows
    .map((row) => recordFromRow(headers, row))
    .filter((row) => row.Organization.trim().length > 0)
    .map((row) => ({
      name: row.Organization.trim(),
      description: row.Description.trim(),
      technology: row.Tech.trim(),
      topic: row.Topic.trim(),
      website: row.Website.trim(),
      gsocLink: row["GSoC-link"].trim(),
      predictedPresence: row[predictionHeader].trim().toLowerCase() === "true",
      probability: Number(row[probabilityHeader]) || 0,
      model: row.Model.trim(),
    }));

  return { organizations, targetYear };
}
