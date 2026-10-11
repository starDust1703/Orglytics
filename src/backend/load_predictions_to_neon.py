#!/usr/bin/env python3
"""Load the prediction CSV produced by the notebook into Neon Postgres.

The loader is intentionally backend-only. It creates the destination table if
needed and upserts one prediction per organization and target year.

Usage:
    python load_predictions_to_neon.py
    python load_predictions_to_neon.py --csv gsoc_t_year_predictions.csv
    python load_predictions_to_neon.py --dry-run
"""
from __future__ import annotations

import argparse
import csv
import os
import re
from pathlib import Path
from typing import Iterable

try:
    from dotenv import load_dotenv
except ImportError:  # Allows --dry-run before optional dependencies are installed.
    def load_dotenv(path: Path) -> None:
        if not path.exists():
            return
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"\''))

try:
    import psycopg
    from psycopg import sql
except ImportError:  # Report a clear setup error only when a database write is requested.
    psycopg = None  # type: ignore[assignment]
    sql = None  # type: ignore[assignment]


ROOT = Path(__file__).resolve().parent
DEFAULT_CSV = ROOT / "gsoc_t_year_predictions.csv"
DEFAULT_TABLE = "gsoc_predictions"
PREDICTION_RE = re.compile(r"^Predicted (?P<year>\d{4})$")
PROBABILITY_RE = re.compile(r"^Probability (?P<year>\d{4})$")
IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
PRESENCE_COLUMNS = ("T-1", "T-2", "T-3", "T-4", "T-5")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upsert GSoC predictions into Neon Postgres.")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV, help="Prediction CSV path.")
    parser.add_argument("--table", default=DEFAULT_TABLE, help="Destination table name.")
    parser.add_argument("--dry-run", action="store_true", help="Validate and report rows without connecting to Neon.")
    return parser.parse_args()


def _table_identifier(name: str) -> sql.Identifier:
    if not IDENTIFIER_RE.fullmatch(name):
        raise ValueError("--table must be a simple PostgreSQL identifier.")
    return sql.Identifier(name)


def _as_bool(value: str) -> bool:
    normalized = value.strip().casefold()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    raise ValueError(f"Invalid prediction boolean: {value!r}")


def _as_optional_bool(value: str | None) -> bool | None:
    if value is None or not value.strip():
        return None
    return _as_bool(value)


def read_predictions(path: Path) -> tuple[int, list[dict[str, object]]]:
    if not path.exists():
        raise FileNotFoundError(f"Prediction CSV not found: {path}")
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = reader.fieldnames or []
        prediction_columns = [PREDICTION_RE.match(name) for name in fieldnames]
        prediction_match = next((match for match in prediction_columns if match), None)
        if prediction_match is None:
            raise ValueError("CSV must contain a column named 'Predicted YYYY'.")
        target_year = int(prediction_match.group("year"))
        probability_column = f"Probability {target_year}"
        required = {
            "Organization", "Description", "Tech", "Topic", "Website", "GSoC-link",
            *PRESENCE_COLUMNS, "Years", f"Predicted {target_year}", probability_column,
            "Model", "Training target",
        }
        missing = sorted(required - set(fieldnames))
        if missing:
            raise ValueError(f"CSV is missing required columns: {', '.join(missing)}")

        rows: list[dict[str, object]] = []
        for line_number, row in enumerate(reader, start=2):
            organization = (row.get("Organization") or "").strip()
            if not organization:
                raise ValueError(f"Row {line_number} has no organization name.")
            try:
                probability = float(row[probability_column] or 0)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Row {line_number} has an invalid probability.") from exc
            if not 0 <= probability <= 1:
                raise ValueError(f"Row {line_number} probability must be between 0 and 1.")
            rows.append({
                "organization": organization,
                "description": (row.get("Description") or "").strip(),
                "tech": (row.get("Tech") or "").strip(),
                "topic": (row.get("Topic") or "").strip(),
                "website": (row.get("Website") or "").strip(),
                "gsoc_link": (row.get("GSoC-link") or "").strip(),
                **{
                    f"t_{index}": _as_optional_bool(row.get(f"T-{index}"))
                    for index in range(1, 6)
                },
                "years": (row.get("Years") or "").strip(),
                "target_year": target_year,
                "predicted_presence": _as_bool(row[f"Predicted {target_year}"]),
                "probability": probability,
                "model": (row.get("Model") or "").strip(),
                "training_target": row["Training target"].strip(),
            })
    return target_year, rows


def create_table(connection: psycopg.Connection, table: str) -> None:
    table_id = _table_identifier(table)
    with connection.cursor() as cursor:
        cursor.execute(sql.SQL("""
            CREATE TABLE IF NOT EXISTS {} (
                organization TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                tech TEXT NOT NULL DEFAULT '',
                topic TEXT NOT NULL DEFAULT '',
                website TEXT NOT NULL DEFAULT '',
                gsoc_link TEXT NOT NULL DEFAULT '',
                t_1 BOOLEAN,
                t_2 BOOLEAN,
                t_3 BOOLEAN,
                t_4 BOOLEAN,
                t_5 BOOLEAN,
                years TEXT NOT NULL DEFAULT '',
                target_year INTEGER NOT NULL,
                predicted_presence BOOLEAN NOT NULL,
                probability DOUBLE PRECISION NOT NULL CHECK (probability >= 0 AND probability <= 1),
                model TEXT NOT NULL DEFAULT '',
                training_target TEXT NOT NULL DEFAULT '',
                loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (organization, target_year)
            )
        """).format(table_id))
        for column in ("t_1", "t_2", "t_3", "t_4", "t_5"):
            cursor.execute(sql.SQL("ALTER TABLE {} ADD COLUMN IF NOT EXISTS {} BOOLEAN").format(
                table_id, sql.Identifier(column)
            ))
        cursor.execute(sql.SQL("ALTER TABLE {} ADD COLUMN IF NOT EXISTS years TEXT NOT NULL DEFAULT ''").format(table_id))


def upsert_rows(connection: psycopg.Connection, table: str, rows: Iterable[dict[str, object]]) -> int:
    table_id = _table_identifier(table)
    query = sql.SQL("""
        INSERT INTO {} (
            organization, description, tech, topic, website, gsoc_link,
            t_1, t_2, t_3, t_4, t_5, years,
            target_year, predicted_presence, probability, model, training_target
        ) VALUES (%(organization)s, %(description)s, %(tech)s, %(topic)s, %(website)s,
                  %(gsoc_link)s, %(t_1)s, %(t_2)s, %(t_3)s, %(t_4)s, %(t_5)s, %(years)s,
                  %(target_year)s, %(predicted_presence)s, %(probability)s,
                  %(model)s, %(training_target)s)
        ON CONFLICT (organization, target_year) DO UPDATE SET
            description = EXCLUDED.description,
            tech = EXCLUDED.tech,
            topic = EXCLUDED.topic,
            website = EXCLUDED.website,
            gsoc_link = EXCLUDED.gsoc_link,
            t_1 = EXCLUDED.t_1,
            t_2 = EXCLUDED.t_2,
            t_3 = EXCLUDED.t_3,
            t_4 = EXCLUDED.t_4,
            t_5 = EXCLUDED.t_5,
            years = EXCLUDED.years,
            predicted_presence = EXCLUDED.predicted_presence,
            probability = EXCLUDED.probability,
            model = EXCLUDED.model,
            training_target = EXCLUDED.training_target,
            loaded_at = NOW()
    """).format(table_id)
    with connection.cursor() as cursor:
        cursor.executemany(query, rows)
    return len(rows) if isinstance(rows, list) else 0


def main() -> int:
    args = parse_args()
    load_dotenv(ROOT / ".env")
    target_year, rows = read_predictions(args.csv.resolve())
    print(f"Validated {len(rows):,} rows for target year {target_year}.")
    if args.dry_run:
        print("Dry run complete; Neon was not contacted.")
        return 0

    if psycopg is None:
        raise RuntimeError("Install the database dependencies with `python -m pip install -r requirements.txt`.")

    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url or database_url.startswith("postgresql://USER:"):
        raise RuntimeError("Set DATABASE_URL in src/backend/.env before loading data into Neon.")

    with psycopg.connect(database_url) as connection:
        create_table(connection, args.table)
        count = upsert_rows(connection, args.table, rows)
        connection.commit()
    print(f"Upserted {count:,} rows into {args.table!r}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
