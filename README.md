# Orglytics

GSoC organization analytics and next-year participation prediction.

## What it does

- Scrapes official Google Summer of Code organization pages and archives.
- Collects descriptions, technologies, topics, websites, and GSoC links.
- Tracks participation across `T-1` through `T-5`.
- Exports the dataset to `src/backend/gsoc_organizations.xlsx`.
- Trains and evaluates prediction models in `src/backend/gsoc_t_year_prediction.ipynb`.

## Backend

Create and activate a virtual environment first:

```bash
cd src/backend
python -m venv .venv
source .venv/bin/activate          # macOS/Linux
# .venv\Scripts\Activate.ps1      # Windows PowerShell
```

Install the dependencies and run the scraper:

```bash
python -m pip install -r requirements.txt
python gsoc_org_scraper.py
```

The workbook contains `Orgs` and `Scrape log` sheets. Predictions estimate organization presence in the next GSoC year, not project acceptance or contributor selection.

The prediction CSV keeps the complete `Orgs` sheet row (`Organization`, `Description`,
`Long Description`, `Tech`, `Topic`, `Website`, `GSoC-link`, `Contributor-guidance`,
`T-1` through `T-5`, and `Years`) and adds
`Predicted YYYY`, `Probability YYYY`, `Model`, and `Training target`. The Neon loader
validates and upserts this complete contract into `gsoc_predictions`.

To load predictions into Neon, copy `.env.example` to `.env`, fill in `DATABASE_URL`, then run:

```bash
python load_predictions_to_neon.py --dry-run
python load_predictions_to_neon.py
```

## Frontend

The Next.js frontend reads organization forecasts through the backend route
`GET /api/organizations`. That route queries the `gsoc_predictions` table in Neon;
the browser and UI components do not read the CSV or connect to the database directly.

Make `DATABASE_URL` available to the Next.js server in the project root `.env.local`,
or keep it in `src/backend/.env` for local development. Never expose it as a
`NEXT_PUBLIC_` variable.

```bash
npm install
npm run dev
```
