# Market Pulse

A self-updating market intelligence site for card partnerships work. It covers premium cards, luxury and affluent consumer trends, partnership sourcing, personal loans and BNPL, and consumer credit. GitHub Actions sweeps dozens of sources three times a day, Claude tags and scores every item, writes the daily and weekly digests, and keeps a set of living pages up to date. GitHub Pages hosts the site, and it's free.

## What's on the site

| Page | What it is | Updates |
|---|---|---|
| **Today** | Breaking items (72h), top signals, latest digest, next 7 days, booking windows opening | Every sweep |
| **Feed** | Every tagged item, searchable, filterable by section, source, relevance and date | Every sweep |
| **Digests** | Daily brief (Tue to Fri), Monday Weekly Edition, Friday Week in Review, earnings recaps | Scheduled |
| **Watchlist** | Potential partners with status (emerging, rumored, signed, acquired) and dated history | Mondays |
| **Benefits** | Competitor premium card benefits and the partner powering each | Mondays |
| **Booking** | Hard-to-book restaurants, hotel openings, events, and when windows open | Mondays (web search) |
| **Dashboard** | Luxury spending indicators carried forward, plus FRED credit card and consumer data | Mondays + daily FRED |
| **Calendar** | Earnings and key dates for the next 6 weeks; earnings get an automatic recap | Mondays (web search) |
| **Companies** | Auto-built page for every company mentioned, with its full coverage timeline | Every sweep |
| **Diligence** | On-demand partner vetting briefs (facts-only Part A, internal Part B) | When requested |
| **Sources & usage** | Feed health and Claude API usage this month | Every sweep |

Sections (tabs in the Feed): Premium Card Intel, Luxury Trends, NYC Dining, Partnership Radar, Personal Loans & BNPL, Spending & Credit Data, Card Community, Regulatory, Wells Fargo.

## Schedule (Eastern, standard time)

| When | Job |
|---|---|
| 6:00am, 12:00pm, 5:00pm daily | Sweep: collect, dedupe, tag, rebuild |
| Mon 6:40am | Living pages refresh, then the Monday Weekly Edition |
| Tue to Fri 6:40am | Daily brief (says "quiet cycle" instead of padding) + any earnings recaps |
| Fri 5:50pm | Week in Review |

GitHub cron runs on UTC, so during daylight saving time everything lands one hour later. Edit the `cron:` lines in `.github/workflows/` to shift it. Scheduled runs can also start a few minutes late when GitHub is busy.

## Setup (about 10 minutes)

1. **Create the repo** on GitHub (public, so Pages is free) and push this code to `main`.
2. **Add your API key.** Get a key at console.anthropic.com. In the repo go to Settings → Secrets and variables → Actions → New repository secret, name it `ANTHROPIC_API_KEY`, and paste the key.
3. **In the Anthropic console**, set a monthly spend limit (e.g. $20) and make sure web search is enabled for your organization in the console settings (an admin may need to turn it on). The Monday edition, booking windows, calendar and Diligence briefs use it.
4. **Turn on Pages.** Go to Settings → Pages → Build and deployment → Source: *Deploy from a branch*, Branch: `main`, folder `/docs`. Your site will be at `https://<user>.github.io/<repo>/`.
5. **Allow Actions to push.** Go to Settings → Actions → General → Workflow permissions and choose *Read and write permissions*.
6. **Run it once now.** Go to the Actions tab → Sweep → Run workflow. When that's done, go to Digest → Run workflow → kind `monday` to fill the living pages and write the first edition.
7. **Share it.** Send your manager the Pages link. To let him request Diligence briefs, add him as a collaborator (Settings → Collaborators).

## Sourcing rules

- Every feed item links to the original publisher, plus any other outlets that covered the same story.
- Every link Claude writes in a digest or brief is checked against the articles and web search results it actually received. A link that can't be matched is removed and marked "source not verified", and each digest ends with a numbered source list.
- Watchlist, Benefits, Booking, Dashboard and Calendar entries are only saved when they carry a verified source link.
- Each digest page lists every item behind it, and the Dashboard links each reading and FRED series to its source.

## Diligence Desk

Open an issue titled `Vet: Company Name` (the Diligence page has a button that pre-fills it). Within a few minutes the brief appears on the site, the issue gets a link, and it closes. Only the repo owner and collaborators can trigger it, so strangers can't spend your credit on a public repo.

Each brief has **Part A: Facts** (shareable, no opinions) and **Part B: Analyst take** (internal). The "Copy facts-only" button copies Part A alone. Web searches stay generic and never include Wells Fargo or internal context.

## Adding sources

All in `config/sources.yaml`:

- **RSS feed:** add `- {name: "...", url: "...", hint: section_id}`.
- **Google News query:** add `- {q: '...', hint: section_id}`. This is the way to cover Bloomberg, FT, Reuters, BoF and other outlets without public feeds (e.g. `site:ft.com luxury`).
- **Email newsletters:** create an inbox at https://kill-the-newsletter.com, subscribe the newsletter to that address, and add the feed URL it gives you as an RSS source.
- **FRED series:** add the series id.

Broken feeds don't break anything. They show as failing on the Sources page, so you can prune them. The topics and companies the tagger knows about are in `config/taxonomy.yaml`, and every prompt is plain Markdown in `prompts/`. Edit those to change tone or structure.

**WSJ:** the site uses WSJ's public RSS headlines and links out, and you read the full article with your own subscription. It never logs in or scrapes behind the paywall.

## Cost

- GitHub Actions and Pages: free on a public repo.
- Tagging (small model): about $3 to $8 a month.
- Digests, living pages and briefs (mid-size model): about $3 to $10 a month.
- Web search: only Mondays, earnings recaps and Diligence briefs. Usually under $2 a month.

The Sources & usage page shows actual tokens and searches month to date. Models and search limits are set in `config/settings.yaml`.

## Run locally

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python -m pulse sweep            # collect + tag + rebuild
python -m pulse digest monday    # or daily / friday / auto
python -m pulse vet "Dorsia"
python -m http.server -d docs 8000   # open http://localhost:8000
```

To test offline without spending anything, run `python tests/test_pipeline.py`. It uses fake feeds and mock Claude output and writes to a temp folder.

## Layout

```
config/      settings, sources, taxonomy (edit these)
prompts/     every prompt Claude uses
pulse/       pipeline: collect, enrich, digest, living, companies, vet, fred
docs/        the site (index.html, app.js, styles.css) + data/ written by the pipeline
.github/workflows/  sweep, digest, vet
```

The site only shows public news. Don't put internal or confidential information in this repo; it's public.
