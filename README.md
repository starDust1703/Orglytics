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

To load predictions into Neon, copy `.env.example` to `.env`, fill in `DATABASE_URL`, then run:

```bash
python load_predictions_to_neon.py --dry-run
python load_predictions_to_neon.py
```

## Frontend

```bash
npm install
npm run dev
```
