#!/usr/bin/env python3
"""Scrape Google Summer of Code organizations and export an Excel workbook.

The reference year is chosen automatically:
- If the current calendar year's GSoC organizations page has >= 1 organization,
  treat the next calendar year as the target year.
- Otherwise, use the current calendar year as the target year.

The workbook contains one row per organization, five year-presence columns,
technology/topics metadata, official-site and contributor-guidance URLs, and a
separate sheet containing every link extracted from each organization's most
recent available detail page. Worksheets use ordinary AutoFilters instead of
native Excel Table objects for compatibility with Excel repair/import behavior.

Usage:
    python gsoc_org_scraper.py
    python gsoc_org_scraper.py --output gsoc_orgs.xlsx
    python gsoc_org_scraper.py --workers 3 --delay 0.25

Dependencies:
    pip install -r requirements.txt
    playwright install chromium
"""
from __future__ import annotations

import argparse
import datetime as dt
import logging
import math
import os
import re
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup, Tag
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_URL = "https://summerofcode.withgoogle.com"
LIST_URL = BASE_URL + "/programs/{year}/organizations"
ARCHIVE_LIST_URL = BASE_URL + "/archive/{year}/organizations/"
ARCHIVE_ROUTE_LAST_YEAR = 2021
USER_AGENT = (
    "Mozilla/5.0 (compatible; GSoCOrganizationResearch/1.0; "
    "+https://summerofcode.withgoogle.com/)"
)
LOG = logging.getLogger("gsoc_scraper")

SOCIAL_HOSTS = {
    "facebook.com", "instagram.com", "linkedin.com", "mastodon.social",
    "x.com", "twitter.com", "youtube.com", "youtu.be", "discord.gg",
    "discord.com", "reddit.com", "t.me", "telegram.me", "bsky.app",
}
SOCIAL_LABELS = {
    "x", "twitter", "facebook", "instagram", "linkedin", "youtube",
    "discord", "mastodon", "reddit", "bluesky", "blog", "email",
}


@dataclass
class OrgCard:
    year: int
    slug: str
    name: str
    description: str = ""
    detail_url: str = ""
    logo_url: str = ""


@dataclass
class YearResult:
    year: int
    organizations: list[OrgCard] = field(default_factory=list)
    status: str = "not_started"
    total_reported: int | None = None
    error: str = ""
    url: str = ""


@dataclass
class OrgProfile:
    long_description: str = ""
    technologies: str = ""
    topics: str = ""
    website_url: str = ""
    contributor_guidance_url: str = ""
    detail_url: str = ""
    logo_url: str = ""
    links: list[dict[str, str]] = field(default_factory=list)
    note: str = ""


class GSoCScraper:
    def __init__(self, delay: float = 0.2, workers: int = 4, browser_fallback: bool = True):
        self.delay = max(0.0, delay)
        self.workers = max(1, min(workers, 8))
        self.browser_fallback = browser_fallback
        self._thread_local = threading.local()
        self._browser_runtime = None
        self._browser = None
        self._browser_page = None
        self._browser_attempted = False
        self._browser_lock = threading.RLock()

    @staticmethod
    def _new_session() -> requests.Session:
        session = requests.Session()
        session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })
        retry = Retry(
            total=3,
            connect=3,
            read=3,
            backoff_factor=0.6,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset({"GET"}),
            respect_retry_after_header=True,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=8, pool_maxsize=8)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        return session

    def _session(self) -> requests.Session:
        if not hasattr(self._thread_local, "session"):
            self._thread_local.session = self._new_session()
        return self._thread_local.session

    def _get_html(self, url: str) -> tuple[str, str, int]:
        response = self._session().get(url, timeout=(12, 35), allow_redirects=True)
        return response.text, response.url, response.status_code

    @staticmethod
    def _clean_text(node: Tag | None) -> str:
        if node is None:
            return ""
        return " ".join(node.get_text(" ", strip=True).split())

    @staticmethod
    def _reported_total(soup: BeautifulSoup) -> int | None:
        text = soup.get_text(" ", strip=True)
        # Angular paginator usually renders text similar to "1 – 50 of 183".
        patterns = (
            r"\b\d[\d,]*\s*[\u2013\u2014-]\s*\d[\d,]*\s+of\s+(\d[\d,]*)\b",
            r"\bof\s+(\d[\d,]*)\s+(?:organizations|results)\b",
        )
        for pattern in patterns:
            match = re.search(pattern, text, flags=re.IGNORECASE)
            if match:
                return int(match.group(1).replace(",", ""))
        if re.search(r"\bno results found\b", text, flags=re.IGNORECASE):
            return 0
        return None

    @staticmethod
    def _listing_url(year: int) -> str:
        """Return the official list route used by the site for a program year."""
        if year <= ARCHIVE_ROUTE_LAST_YEAR:
            return ARCHIVE_LIST_URL.format(year=year)
        return LIST_URL.format(year=year)

    @staticmethod
    def _organization_path_pattern(year: int) -> re.Pattern[str]:
        if year <= ARCHIVE_ROUTE_LAST_YEAR:
            return re.compile(rf"^/archive/{year}/organizations/([^/?#]+)/?$")
        return re.compile(rf"^/programs/{year}/organizations/([^/?#]+)/?$")

    @staticmethod
    def _extract_cards(html: str, year: int) -> list[OrgCard]:
        soup = BeautifulSoup(html, "html.parser")
        pattern = GSoCScraper._organization_path_pattern(year)
        cards: dict[str, OrgCard] = {}
        for anchor in soup.select('a[href*="/organizations/"]'):
            href = anchor.get("href", "").strip()
            parsed = urlparse(href)
            path = parsed.path if parsed.path else href
            match = pattern.match(path)
            if not match:
                continue
            slug = match.group(1)
            name = GSoCScraper._clean_text(anchor.select_one(".name"))
            description = GSoCScraper._clean_text(anchor.select_one(".short-description"))
            image = anchor.select_one("img[src]")
            logo_url = urljoin(BASE_URL, image.get("src", "")) if image else ""
            if not name:
                name = re.sub(r"[-_]", " ", slug).strip().title()
            cards[slug] = OrgCard(
                year=year,
                slug=slug,
                name=name,
                description=description,
                detail_url=urljoin(BASE_URL, href),
                logo_url=logo_url,
            )
        return list(cards.values())

    @staticmethod
    def _extract_name_from_card_locator(card: Any, year: int) -> OrgCard | None:
        try:
            href = card.get_attribute("href") or ""
            route = "archive" if year <= ARCHIVE_ROUTE_LAST_YEAR else "programs"
            match = re.search(rf"/{route}/{year}/organizations/([^/?#]+)", href)
            if not match:
                return None
            slug = match.group(1)
            name = (card.locator(".name").first.inner_text(timeout=1500).strip()
                    if card.locator(".name").count() else "")
            description = (card.locator(".short-description").first.inner_text(timeout=1500).strip()
                           if card.locator(".short-description").count() else "")
            logo_url = ""
            if card.locator("img[src]").count():
                logo_url = card.locator("img[src]").first.get_attribute("src") or ""
                logo_url = urljoin(BASE_URL, logo_url)
            if not name:
                name = re.sub(r"[-_]", " ", slug).strip().title()
            return OrgCard(year, slug, name, description, urljoin(BASE_URL, href), logo_url)
        except Exception:
            return None

    def _ensure_browser(self) -> Any:
        if self._browser_page is not None:
            return self._browser_page
        self._browser_attempted = True
        try:
            from playwright.sync_api import sync_playwright  # optional, used for pagination
        except ImportError as exc:
            raise RuntimeError(
                "The GSoC listing is paginated, and the static HTML did not contain all rows. "
                "Install browser support with `pip install playwright` followed by "
                "`playwright install chromium`, then run this script again."
            ) from exc
        self._browser_runtime = sync_playwright().start()
        try:
            self._browser = self._browser_runtime.chromium.launch(headless=True)
            context = self._browser.new_context(
                user_agent=USER_AGENT,
                locale="en-US",
                ignore_https_errors=False,
            )
            self._browser_page = context.new_page()
            self._browser_page.set_default_timeout(12000)
            return self._browser_page
        except Exception as exc:
            self.close()
            raise RuntimeError(
                "Playwright could not launch Chromium. Run `playwright install chromium` "
                "and check that the browser's system dependencies are installed."
            ) from exc

    @staticmethod
    def _browser_total(page: Any) -> int | None:
        try:
            body_text = page.locator("body").inner_text(timeout=3000)
        except Exception:
            return None
        patterns = (
            r"\b\d[\d,]*\s*[\u2013\u2014-]\s*\d[\d,]*\s+of\s+(\d[\d,]*)\b",
            r"\bof\s+(\d[\d,]*)\s+(?:organizations|results)\b",
        )
        for pattern in patterns:
            match = re.search(pattern, body_text, flags=re.IGNORECASE)
            if match:
                return int(match.group(1).replace(",", ""))
        if re.search(r"\bno results found\b", body_text, flags=re.IGNORECASE):
            return 0
        return None

    def _fetch_listing_browser(self, year: int, expected_total: int | None) -> list[OrgCard]:
        """Fetch every listing page using robust paginator-state detection.

        The site is an Angular app and its paginator markup can change. Instead of
        depending on one CSS class or only the first card's href, this method
        checks the full set of card hrefs and the visible ``start–end of total``
        range after every attempted pagination action.
        """
        page = self._ensure_browser()
        url = self._listing_url(year)
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        route = "archive" if year <= ARCHIVE_ROUTE_LAST_YEAR else "programs"
        selector = f'a[href*="/{route}/{year}/organizations/"]'
        try:
            page.wait_for_selector(selector, timeout=20000)
        except Exception:
            # Empty years may legitimately contain no cards.
            pass

        browser_total = self._browser_total(page)
        total = browser_total if browser_total is not None else expected_total
        orgs: dict[str, OrgCard] = {}

        def card_hrefs() -> list[str]:
            try:
                return page.locator(selector).evaluate_all(
                    "els => els.map(el => el.getAttribute('href') || '').filter(Boolean)"
                )
            except Exception:
                return []

        def range_text() -> str:
            try:
                body = page.locator("body").inner_text(timeout=2500)
            except Exception:
                return ""
            match = re.search(
                r"\b\d[\d,]*\s*[\u2013\u2014-]\s*\d[\d,]*\s+of\s+\d[\d,]*\b",
                body,
                flags=re.IGNORECASE,
            )
            return re.sub(r"\s+", " ", match.group(0)).strip() if match else ""

        def state_changed(old_hrefs: list[str], old_range: str, timeout_ms: int = 4500) -> bool:
            try:
                page.wait_for_function(
                    "args => {"
                    " const links = Array.from(document.querySelectorAll(args.selector))"
                    "   .map(el => el.getAttribute('href') || '').filter(Boolean);"
                    " const text = document.body ? document.body.innerText : '';"
                    " const m = text.match(/\\b\\d[\\d,]*\\s*[–—-]\\s*\\d[\\d,]*\\s+of\\s+\\d[\\d,]*\\b/i);"
                    " const currentRange = m ? m[0].replace(/\\s+/g, ' ').trim() : '';"
                    " return JSON.stringify(links) !== JSON.stringify(args.oldHrefs)"
                    "   || currentRange !== args.oldRange;"
                    "}",
                    arg={"selector": selector, "oldHrefs": old_hrefs, "oldRange": old_range},
                    timeout=timeout_ms,
                )
            except Exception:
                pass
            return card_hrefs() != old_hrefs or range_text() != old_range

        def control_debug() -> str:
            try:
                controls = page.locator("button, [role='button'], a, select, mat-select, .mat-mdc-select").evaluate_all(
                    "els => els.map(el => ({"
                    " tag: el.tagName, text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),"
                    " aria: el.getAttribute('aria-label') || '', title: el.getAttribute('title') || '',"
                    " cls: typeof el.className === 'string' ? el.className : '',"
                    " icon: Array.from(el.querySelectorAll('mat-icon, [class*=icon], svg, i')).map(n => ((n.innerText || n.textContent || '') + ' ' + (typeof n.className === 'string' ? n.className : '')).trim()).join(' '),"
                    " disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',"
                    " value: el.value || ''"
                    "})).filter(x => /next|prev|first|last|page|paginator|items per/i.test([x.text,x.aria,x.title,x.cls].join(' '))).slice(0, 20)"
                )
                return repr(controls)
            except Exception as exc:
                return f"control inspection failed: {exc}"

        def try_click_next(old_hrefs: list[str], old_range: str) -> bool:
            # Inspect actual live controls, not only one guessed Angular Material
            # class. The element indexes map to the combined locator below.
            all_controls = page.locator("button, [role='button'], a")
            try:
                candidates = all_controls.evaluate_all(
                    "els => els.map((el, index) => ({index, tag: el.tagName,"
                    " aria: el.getAttribute('aria-label') || '', title: el.getAttribute('title') || '',"
                    " cls: typeof el.className === 'string' ? el.className : '',"
                    " text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),"
                    " icon: Array.from(el.querySelectorAll('mat-icon, [class*=icon], svg, i'))"
                    "   .map(n => ((n.innerText || n.textContent || '') + ' ' + (typeof n.className === 'string' ? n.className : '') + ' ' + (n.getAttribute('aria-label') || '')).trim()).join(' '),"
                    " disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'"
                    "})).filter(x => /next|forward|chevron[_ -]?right|navigate[_ -]?next|keyboard[_ -]?arrow[_ -]?right|arrow[_ -]?forward|last[_ -]?page/i.test([x.aria,x.title,x.cls,x.text,x.icon].join(' '))"
                    " || (x.tag === 'BUTTON' && /^(›|»|>|→|❯|❯❯)$/u.test(x.text)))"
                )
            except Exception:
                candidates = []

            # Prefer accessible labels, then paginator classes/text. Try a few
            # candidates because sites sometimes leave a disabled duplicate in DOM.
            candidates.sort(key=lambda x: (
                0 if (x.get("aria") or x.get("title")) else 1,
                1 if x.get("disabled") else 0,
            ))
            for candidate in candidates[:12]:
                if candidate.get("disabled"):
                    continue
                try:
                    control = all_controls.nth(int(candidate["index"]))
                    if not control.is_visible(timeout=800):
                        continue
                    if control.is_disabled():
                        continue
                    control.click(timeout=2500)
                    if state_changed(old_hrefs, old_range):
                        return True
                except Exception:
                    continue

            # Some Angular Material builds expose only a chevron icon, with no
            # accessible label or useful button text. Find the smallest ancestor
            # containing the visible "1–50 of 183" range, then try its final enabled
            # button (normally the next/last-page control). Avoid guessing globally.
            try:
                pager_buttons = page.evaluate(r"""() => {
                  const range = /\b\d[\d,]*\s*[–—-]\s*\d[\d,]*\s+of\s+\d[\d,]*\b/i;
                  const nodes = Array.from(document.querySelectorAll('body *'))
                    .filter(el => el.children.length <= 2 && range.test((el.innerText || el.textContent || '').trim()));
                  nodes.sort((a, b) => (a.innerText || a.textContent || '').length - (b.innerText || b.textContent || '').length);
                  let node = nodes[0] || null;
                  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
                    const items = Array.from(node.querySelectorAll('button, [role="button"], a'))
                      .filter(el => el.offsetParent !== null && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
                    if (items.length >= 1 && items.length <= 8) {
                      const controls = Array.from(document.querySelectorAll('button, [role="button"], a'));
                      return items.map(el => ({
                        index: controls.indexOf(el),
                        text: (el.innerText || el.textContent || '').trim(),
                        aria: el.getAttribute('aria-label') || '',
                        title: el.getAttribute('title') || '',
                        cls: typeof el.className === 'string' ? el.className : '',
                        icon: Array.from(el.querySelectorAll('mat-icon, [class*=icon], svg, i')).map(n => ((n.innerText || n.textContent || '') + ' ' + (typeof n.className === 'string' ? n.className : '')).trim()).join(' ')
                      }));
                    }
                  }
                  return [];
                }""")
                # The previous DOM inspection is only for ranking. Re-query visible
                # controls and try them from the end of the paginator control group.
                if pager_buttons:
                    for candidate in reversed(pager_buttons):
                        idx = candidate.get("index", -1)
                        if idx < 0:
                            continue
                        control = all_controls.nth(idx)
                        try:
                            label = " ".join(filter(None, [
                                candidate.get("aria", ""), candidate.get("title", ""),
                                candidate.get("cls", ""), candidate.get("text", ""), candidate.get("icon", ""),
                            ])).casefold()
                            if re.search(r"previous|prev|first|page size|items per page", label):
                                continue
                            if not control.is_visible(timeout=300) or control.is_disabled():
                                continue
                            control.click(timeout=1200)
                            if state_changed(old_hrefs, old_range, timeout_ms=3000):
                                return True
                        except Exception:
                            continue
            except Exception:
                pass
            return False

        def try_increase_page_size(old_hrefs: list[str], old_range: str) -> bool:
            # First handle a native <select>, if the site exposes one.
            try:
                native_selects = page.locator("select")
                for i in range(native_selects.count()):
                    dropdown = native_selects.nth(i)
                    try:
                        info = dropdown.evaluate(
                            "el => ({value: el.value, options: Array.from(el.options).map(o => ({"
                            "value: o.value, text: (o.textContent || '').trim(), disabled: o.disabled"
                            "}))})"
                        )
                        choices = []
                        for option in info["options"]:
                            m = re.fullmatch(r"\s*(\d[\d,]*)\s*", option["text"])
                            if m and not option["disabled"]:
                                value = int(m.group(1).replace(",", ""))
                                choices.append((value, option["value"]))
                        current = int(info.get("value", "0")) if str(info.get("value", "")).isdigit() else 0
                        larger = [item for item in choices if item[0] > current]
                        if larger:
                            _, value = max(larger)
                            dropdown.select_option(value=value, timeout=2500)
                            if state_changed(old_hrefs, old_range):
                                return True
                    except Exception:
                        continue
            except Exception:
                pass

            # Angular Material select controls are not native selects. Open only
            # likely paginator page-size controls, then select the largest numeric option.
            likely_selectors = (
                ".mat-mdc-paginator-page-size .mat-mdc-select",
                ".mat-paginator-page-size .mat-select",
                "mat-paginator mat-select",
                "mat-paginator .mat-mdc-select",
            )
            for css in likely_selectors:
                try:
                    dropdowns = page.locator(css)
                    for i in range(dropdowns.count()):
                        dropdown = dropdowns.nth(i)
                        if not dropdown.is_visible(timeout=500):
                            continue
                        label = " ".join(filter(None, [
                            dropdown.get_attribute("aria-label"),
                            dropdown.get_attribute("title"),
                            dropdown.locator("xpath=..").get_attribute("class"),
                        ])).casefold()
                        if "page" not in label and "paginator" not in label and "items" not in label:
                            continue
                        dropdown.click(timeout=2000)
                        options = page.locator("[role='option'], mat-option")
                        numeric_options: list[tuple[int, Any]] = []
                        for j in range(options.count()):
                            option = options.nth(j)
                            text = option.inner_text(timeout=500).strip()
                            match = re.fullmatch(r"\d[\d,]*", text)
                            if match and option.is_visible():
                                numeric_options.append((int(text.replace(",", "")), option))
                        if not numeric_options:
                            try:
                                page.keyboard.press("Escape")
                            except Exception:
                                pass
                            continue
                        value, option = max(numeric_options, key=lambda pair: pair[0])
                        option.click(timeout=2000)
                        if state_changed(old_hrefs, old_range):
                            LOG.info("Year %s: increased page size to %s using Angular select.", year, value)
                            return True
                except Exception:
                    try:
                        page.keyboard.press("Escape")
                    except Exception:
                        pass
                    continue
            return False

        max_steps = max(10, math.ceil(total / 5) + 5) if total else 100
        for _ in range(max_steps):
            # Collect the currently rendered cards.
            try:
                anchors = page.locator(selector)
                for index in range(anchors.count()):
                    item = self._extract_name_from_card_locator(anchors.nth(index), year)
                    if item:
                        orgs[item.slug] = item
            except Exception as exc:
                LOG.debug("Could not read a browser page for %s: %s", year, exc)

            if total is not None and len(orgs) >= total:
                break
            if total == 0:
                return []

            old_hrefs = card_hrefs()
            old_range = range_text()
            if not old_hrefs:
                break

            # First attempt normal forward pagination; if no control advances the
            # state, try increasing the page size before giving up.
            advanced = try_click_next(old_hrefs, old_range)
            if not advanced:
                advanced = try_increase_page_size(old_hrefs, old_range)
            if not advanced:
                break

        if total is not None and len(orgs) < total:
            raise RuntimeError(
                f"Could only read {len(orgs)} of {total} organizations for {year}. "
                f"Visible paginator range: {range_text() or '(not found)'}. "
                "Tried accessible Next/Forward controls and page-size selectors, but the listing "
                f"did not advance. Detected controls: {control_debug()}."
            )
        if not orgs and total != 0:
            raise RuntimeError(f"No organization cards could be read from {url}")
        return list(orgs.values())

    def fetch_listing(self, year: int) -> YearResult:
        url = self._listing_url(year)
        result = YearResult(year=year, url=url)
        try:
            html, final_url, status = self._get_html(url)
        except requests.RequestException as exc:
            result.status = "request_error"
            result.error = str(exc)
            result.url = url
            return result

        result.url = final_url or url
        if status == 404:
            result.status = "not_found"
            result.error = "HTTP 404; treated as no published organization list for this year."
            return result
        if status >= 400:
            result.status = f"http_{status}"
            result.error = f"HTTP {status} returned by organization list page."
            return result

        soup = BeautifulSoup(html, "html.parser")
        cards = self._extract_cards(html, year)
        total = self._reported_total(soup)
        result.total_reported = total

        page_text = soup.get_text(" ", strip=True)
        explicitly_empty = (
            total == 0
            or re.search(r"no results found", page_text, flags=re.IGNORECASE) is not None
        )

        # GSoC is an Angular app. Depending on cache/CDN and server-side rendering,
        # requests may receive a shell with neither cards nor a paginator count.
        # In that case, still try Chromium; previously this path was incorrectly
        # classified as empty_or_unrecognized before browser fallback could run.
        # If a count is missing, card count alone cannot prove that the listing
        # is complete: the first page may still contain only 50 organizations.
        needs_browser = (not explicitly_empty) and (
            not cards or total is None or len(cards) < total
        )
        if needs_browser and self.browser_fallback:
            if total is None:
                LOG.info(
                    "Year %s returned no parseable static cards/count; trying Chromium rendering.",
                    year,
                )
            else:
                LOG.info(
                    "Year %s has %s/%s cards in static HTML; using browser pagination.",
                    year, len(cards), total,
                )
            try:
                cards = self._fetch_listing_browser(year, total)
            except Exception as exc:
                result.status = "incomplete"
                title = soup.title.get_text(" ", strip=True) if soup.title else "(no HTML title)"
                result.error = (
                    f"Static HTML parsed {len(cards)} cards (reported total: {total}); "
                    f"browser fallback failed: {exc}. Response title: {title!r}."
                )
                return result
        elif needs_browser:
            result.status = "incomplete"
            if total is None:
                result.error = (
                    f"Static HTML exposed {len(cards)} cards but no verifiable total. "
                    "Cannot assume a single rendered page is the complete organization list."
                )
            else:
                result.error = f"Static HTML exposed {len(cards)} of {total} organizations."
            return result

        # Some older pages may not display a count label; if a list is present,
        # use its cards as the available dataset rather than guessing totals.
        result.organizations = cards
        if cards:
            result.status = "ok"
        elif explicitly_empty:
            result.status = "empty"
        else:
            result.status = "empty_or_unrecognized"
            result.error = (
                "No organization cards were parsed from static HTML, and browser fallback "
                "was unavailable or disabled. Check Playwright/Chromium installation and "
                "the page response."
            )
        return result

    @staticmethod
    def _normalized_name(name: str) -> str:
        name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
        name = name.casefold()
        return re.sub(r"[^a-z0-9]+", " ", name).strip()

    @staticmethod
    def _external_http(url: str) -> bool:
        try:
            parsed = urlparse(url)
            return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
        except Exception:
            return False

    @staticmethod
    def _is_utility_link(link: dict[str, str]) -> bool:
        """Exclude consent, legal, and platform utility links from website guesses."""
        host = link.get("host", "").casefold().removeprefix("www.")
        text = link.get("text", "").casefold()
        path = urlparse(link.get("url", "")).path.casefold()
        if host in {"policies.google.com", "consent.google.com", "accounts.google.com"}:
            return True
        utility_terms = (
            "cookie", "privacy policy", "terms of service", "terms and conditions",
            "legal notice", "imprint", "accessibility statement",
        )
        return any(term in text or term.replace(" ", "-") in path for term in utility_terms)

    @staticmethod
    def _ancestor_context(anchor: Tag, max_depth: int = 3) -> str:
        pieces: list[str] = []
        current: Tag | None = anchor
        depth = 0
        while current is not None and depth <= max_depth:
            if isinstance(current, Tag):
                class_value = current.get("class", [])
                if isinstance(class_value, list):
                    pieces.extend(str(item) for item in class_value)
                aria = current.get("aria-label")
                title = current.get("title")
                if aria:
                    pieces.append(str(aria))
                if title:
                    pieces.append(str(title))
            current = current.parent if isinstance(current.parent, Tag) else None
            depth += 1
        return " ".join(pieces).casefold()

    @staticmethod
    def _nearby_visible_text(anchor: Tag, max_depth: int = 4, max_chars: int = 350) -> str:
        """Return short nearby visible text without accidentally using whole-page text."""
        current: Tag | None = anchor.parent if isinstance(anchor.parent, Tag) else None
        for _ in range(max_depth):
            if not isinstance(current, Tag):
                break
            text = " ".join(current.get_text(" ", strip=True).split())
            link_count = len(current.find_all("a", href=True))
            if text and len(text) <= max_chars and link_count <= 2:
                return text
            current = current.parent if isinstance(current.parent, Tag) else None
        return ""

    @staticmethod
    def _find_url_after_label(soup: BeautifulSoup, label_pattern: str, detail_url: str) -> str:
        """Find the first external link in the small DOM section immediately following a label."""
        label_re = re.compile(label_pattern, re.IGNORECASE)
        label_node = None
        for node in soup.find_all(string=label_re):
            if node.strip():
                label_node = node.parent
                break
        if label_node is None:
            return ""

        current: Tag | None = label_node
        for depth in range(5):
            if not isinstance(current, Tag):
                break
            anchors = current.find_all("a", href=True)
            section_text = " ".join(current.get_text(" ", strip=True).split())
            # Don't search the whole page/article. Guidance blocks are small and
            # generally contain only one or two links.
            if len(anchors) <= 3 and len(section_text) <= 500:
                descendants = list(current.descendants)
                try:
                    label_index = descendants.index(label_node)
                except ValueError:
                    label_index = -1
                for item in descendants[label_index + 1:]:
                    if isinstance(item, Tag) and item.name in {"h1", "h2", "h3", "h4"}:
                        if re.search(r"projects|contributors|mentors|organization description", item.get_text(" ", strip=True), re.I):
                            break
                    if isinstance(item, Tag) and item.name == "a" and item.get("href"):
                        href = urljoin(detail_url, item.get("href", "").strip())
                        if GSoCScraper._external_http(href):
                            return href
            current = current.parent if isinstance(current.parent, Tag) else None
        return ""

    @staticmethod
    def _split_tags(text: str) -> str:
        return re.sub(r"\s*,\s*", ", ", " ".join(text.split())).strip(" ,")

    @staticmethod
    def _clean_long_description(node: Tag | None) -> str:
        if node is None:
            return ""
        paragraphs = []
        for paragraph in node.get_text("\n", strip=True).splitlines():
            cleaned = " ".join(paragraph.split())
            if cleaned:
                paragraphs.append(cleaned)
        return "\n\n".join(paragraphs)

    def fetch_profile(self, card: OrgCard) -> OrgProfile:
        """Fetch profile HTML over HTTP and parse it without launching a browser."""
        try:
            html, final_url, status = self._get_html(card.detail_url)
        except requests.RequestException as exc:
            return OrgProfile(
                detail_url=card.detail_url,
                logo_url=card.logo_url,
                note=f"Detail page request failed: {exc}",
            )
        if status >= 400:
            return OrgProfile(
                detail_url=final_url or card.detail_url,
                logo_url=card.logo_url,
                note=f"Detail page returned HTTP {status}.",
            )
        return self._parse_profile_html(card, html, final_url or card.detail_url)

    def fetch_profile_browser(self, card: OrgCard) -> OrgProfile:
        """Render a profile in Chromium when static HTML lacks the expected Angular data."""
        try:
            page = self._ensure_browser()
            page.goto(card.detail_url, wait_until="domcontentloaded", timeout=60000)
            try:
                page.wait_for_selector(".bd, .tags, .tech__content, .topics__content", timeout=9000)
            except Exception:
                # Some valid organization pages expose links but omit one/both tag blocks.
                page.wait_for_timeout(800)
            html = page.content()
            final_url = page.url or card.detail_url
            profile = self._parse_profile_html(card, html, final_url)
            if not profile.long_description and not profile.technologies and not profile.topics and not profile.links:
                profile.note = (profile.note + " Chromium rendering also exposed no description, technology/topic tags or links.").strip()
            return profile
        except Exception as exc:
            return OrgProfile(
                detail_url=card.detail_url,
                logo_url=card.logo_url,
                note=f"Browser-rendered detail scrape failed: {exc}",
            )

    def _parse_profile_html(self, card: OrgCard, html: str, detail_url: str) -> OrgProfile:
        profile = OrgProfile(detail_url=detail_url, logo_url=card.logo_url)
        soup = BeautifulSoup(html, "html.parser")
        profile.long_description = self._clean_long_description(soup.select_one(".bd"))
        tech = soup.select_one(".tags .tag.tech .tech__content") or soup.select_one(".tech__content")
        topics = soup.select_one(".tags .tag.topics .topics__content") or soup.select_one(".topics__content")
        profile.technologies = self._split_tags(self._clean_text(tech))
        profile.topics = self._split_tags(self._clean_text(topics))

        # The rendered GSoC organization detail component exposes the official
        # website in this dedicated link wrapper. Prefer it over any unrelated
        # external links elsewhere on the page, such as cookie-policy links.
        official_website = soup.select_one(
            "app-org-info-details .link__wrapper a.link, "
            ".link__wrapper a.link"
        )
        if official_website:
            official_href = urljoin(detail_url, official_website.get("href", "").strip())
            if self._external_http(official_href):
                profile.website_url = official_href

        profile.contributor_guidance_url = ""
        # GSoC commonly exposes contributor instructions as a button immediately
        # before the detail component, labeled "View ideas list" rather than
        # "Contributor Guidance".
        for guidance_anchor in soup.select("app-org-info .button-wrapper a, .button-wrapper a"):
            guidance_text = " ".join(guidance_anchor.get_text(" ", strip=True).split())
            guidance_context = " ".join(
                guidance_anchor.parent.get_text(" ", strip=True).split()
            ) if isinstance(guidance_anchor.parent, Tag) else guidance_text
            if not re.search(
                r"view\s+ideas\s+list|contributor\s+guidance|project\s+ideas|contributing\s+guide",
                f"{guidance_text} {guidance_context}",
                re.IGNORECASE,
            ):
                continue
            guidance_href = urljoin(detail_url, guidance_anchor.get("href", "").strip())
            if self._external_http(guidance_href):
                profile.contributor_guidance_url = guidance_href
                break

        # Preserve all links from the rendered detail page, including project links,
        # socials, emails and internal GSoC links.
        all_links: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for anchor in soup.find_all("a", href=True):
            raw_href = anchor.get("href", "").strip()
            if not raw_href or raw_href.startswith(("javascript:", "#")):
                continue
            href = urljoin(profile.detail_url, raw_href)
            if not href.startswith(("http://", "https://", "mailto:")):
                continue
            text = self._clean_text(anchor)
            if not text:
                text = str(anchor.get("aria-label") or anchor.get("title") or "").strip()
            if not text:
                image = anchor.select_one("img[alt]")
                if image:
                    text = str(image.get("alt", "")).strip()
            if not text:
                text = urlparse(href).netloc or href
            key = (text.casefold(), href)
            if key in seen:
                continue
            seen.add(key)

            host = urlparse(href).netloc.casefold().removeprefix("www.")
            context = self._ancestor_context(anchor) + " " + self._nearby_visible_text(anchor)
            combined = (text + " " + context).casefold()
            if href.startswith("mailto:"):
                kind = "email"
            elif "contributor" in combined and "guidance" in combined:
                kind = "contributor_guidance"
            elif any(label in combined for label in ("website", "official site", "organization site")):
                kind = "website"
            elif host.endswith("summerofcode.withgoogle.com"):
                kind = "gsoc_internal"
            elif any(host == social or host.endswith("." + social) for social in SOCIAL_HOSTS):
                kind = "social_or_community"
            else:
                kind = "external_or_other"

            all_links.append({
                "text": text[:1000],
                "url": href[:4000],
                "type": kind,
                "host": host[:255],
            })
        profile.links = all_links

        if not profile.contributor_guidance_url:
            for link in all_links:
                if link["type"] == "contributor_guidance" and self._external_http(link["url"]):
                    profile.contributor_guidance_url = link["url"]
                    break

        if not profile.contributor_guidance_url:
            for link in all_links:
                if re.search(r"contributor\s+guidance|contributing\s+guide|how\s+to\s+contribute", link["text"], re.I):
                    if self._external_http(link["url"]):
                        profile.contributor_guidance_url = link["url"]
                        break

        if not profile.contributor_guidance_url:
            candidate_guidance = self._find_url_after_label(
                soup, r"contributor\s+guidance", profile.detail_url
            )
            if candidate_guidance and any(link["url"] == candidate_guidance for link in all_links):
                profile.contributor_guidance_url = candidate_guidance

        if not profile.website_url:
            website_candidates: list[tuple[int, str, str, str]] = []
            guidance_position = len(all_links)
            organization_tokens = [
                token for token in re.findall(r"[a-z0-9]+", self._normalized_name(card.name))
                if len(token) >= 4
            ]
            compact_organization_name = "".join(organization_tokens)
            for index, link in enumerate(all_links):
                if link["url"] == profile.contributor_guidance_url:
                    guidance_position = min(guidance_position, index)
                if not self._external_http(link["url"]):
                    continue
                host = link["host"].removeprefix("www.")
                text = link["text"].strip()
                lower_text = text.casefold()
                if (lower_text.strip() in SOCIAL_LABELS or
                        re.match(r"^(twitter|facebook|instagram|linkedin|youtube|discord|mastodon|reddit|bluesky)(?:\s|$)", lower_text.strip())):
                    continue
                if any(host == social or host.endswith("." + social) for social in SOCIAL_HOSTS):
                    continue
                if link["url"] == profile.contributor_guidance_url:
                    continue
                if self._is_utility_link(link) and link["type"] != "website":
                    continue
                score = 0
                if link["type"] == "website":
                    score += 30
                if re.match(r"https?://", text, re.I) or re.fullmatch(r"[\w.-]+\.[a-z]{2,}(?:/.*)?", text, re.I):
                    score += 5
                compact_host = re.sub(r"[^a-z0-9]+", "", host)
                if compact_organization_name and compact_organization_name in compact_host:
                    score += 15
                else:
                    score += sum(4 for token in organization_tokens if token in compact_host)
                score += max(0, 3 - index)
                website_candidates.append((score, link["url"], text, str(index)))
            if website_candidates:
                explicit = [candidate for candidate in website_candidates if candidate[0] >= 10]
                pool = explicit or website_candidates
                before_guidance = [candidate for candidate in pool if int(candidate[3]) < guidance_position]
                chosen = max(before_guidance or pool, key=lambda item: item[0])
                profile.website_url = chosen[1]

        for link in profile.links:
            if profile.contributor_guidance_url and link["url"] == profile.contributor_guidance_url:
                link["type"] = "contributor_guidance"
            elif profile.website_url and link["url"] == profile.website_url:
                link["type"] = "website"

        if not profile.technologies and not profile.topics:
            profile.note = "Technology/topic tags were not found in the page HTML."
        return profile

    def close(self) -> None:
        try:
            if self._browser is not None:
                self._browser.close()
        except Exception:
            pass
        try:
            if self._browser_runtime is not None:
                self._browser_runtime.stop()
        except Exception:
            pass
        self._browser = None
        self._browser_page = None
        self._browser_runtime = None


def _safe_sheet_title(text: str) -> str:
    return re.sub(r"[\\/*?:\[\]]", "_", text)[:31]


def _style_sheet(ws, header_row: int = 1, freeze: str = "A2") -> None:
    header_fill = PatternFill("solid", fgColor="17365D")
    header_font = Font(name="Aptos", bold=True, color="FFFFFF", size=10)
    thin_gray = "D9E2F3"
    for cell in ws[header_row]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(vertical="center", horizontal="center", wrap_text=True)
    ws.row_dimensions[header_row].height = 34
    ws.freeze_panes = freeze
    # Use a normal worksheet AutoFilter, not an Excel Table. Native table XML
    # caused Excel to repair/remove table and table-filter definitions on some installs.
    ws.auto_filter.ref = ws.dimensions
    for row in ws.iter_rows(min_row=header_row + 1):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=True)
            cell.border = Border(bottom=Side(style="hair", color=thin_gray))



def _limit_widths(ws, max_width: int = 42) -> None:
    for column_cells in ws.columns:
        letter = column_cells[0].column_letter
        header = str(column_cells[0].value or "")
        content_lengths = [len(str(cell.value)) for cell in column_cells[1:250] if cell.value is not None]
        measured = max([len(header)] + content_lengths + [10])
        if header.startswith("T-"):
            width = 13
        elif "URL" in header or "Link" in header:
            width = 34
        elif header in {"Organization", "Name"}:
            width = 32
        elif header in {"Description", "Long Description", "Technologies", "Topics", "Text"}:
            width = 34
        else:
            width = min(max_width, max(12, measured + 2))
        ws.column_dimensions[letter].width = width


def export_workbook(
    output_path: str,
    baseline_year: int,
    current_year: int,
    current_year_had_orgs: bool,
    year_results: dict[int, YearResult],
    organizations: dict[str, dict[str, Any]],
    scrape_log: list[dict[str, str]],
) -> None:
    wb = Workbook()
    org_ws = wb.active
    org_ws.title = "Orgs"

    history_years = [baseline_year - offset for offset in range(1, 6)]
    presence_headers = [f"T-{offset}" for offset in range(1, 6)]
    headers = [
        "Organization", "Description", "Long Description", "Tech", "Topic", "Website", "GSoC-link", "Contributor-guidance",
        *presence_headers, "Years",
    ]
    org_ws.append(headers)

    rows = []
    for key, record in organizations.items():
        presence = []
        observed_years = []
        for year in history_years:
            result = year_results.get(year)
            if result is None or result.status not in {"ok", "empty"}:
                presence.append(None)  # Unknown rather than falsely claiming absence.
            else:
                present = year in record["years"]
                presence.append(bool(present))
                if present:
                    observed_years.append(year)
        profile: OrgProfile = record["profile"]
        rows.append([
            record["name"], record.get("description", ""), profile.long_description,
            profile.technologies, profile.topics, profile.website_url, profile.detail_url,
            profile.contributor_guidance_url,
            *presence, ", ".join(map(str, sorted(observed_years, reverse=True))),
        ])

    # Put organizations with the most observed years first, then alphabetical.
    def row_sort_key(row: list[Any]) -> tuple[int, str]:
        bool_values = row[8:13]
        count = sum(value is True for value in bool_values)
        return (-count, str(row[0]).casefold())

    rows.sort(key=row_sort_key)
    if not rows or not any(str(row[0] or "").strip() for row in rows):
        raise RuntimeError(
            "Refusing to export a schema-only workbook: zero organization rows were assembled. "
            "Check the year listing counts in Scrape log and the console output."
        )
    for row in rows:
        org_ws.append(row)
    _style_sheet(org_ws)
    _limit_widths(org_ws)
    org_ws.sheet_view.showGridLines = False

    log_ws = wb.create_sheet("Scrape log")
    log_ws.append(["year", "total_orgs"])
    for year in sorted(year_results, reverse=True):
        result = year_results[year]
        log_ws.append([year, len(result.organizations)])
    _style_sheet(log_ws)
    _limit_widths(log_ws)
    log_ws.sheet_view.showGridLines = False

    # Save to a temporary workbook, reopen it, and only replace the destination
    # after verifying actual organization records exist. This prevents a silent
    # schema-only file from being treated as a successful scrape.
    output_path = os.path.abspath(output_path)
    output_dir = os.path.dirname(output_path) or "."
    os.makedirs(output_dir, exist_ok=True)
    temp_path = output_path + ".tmp.xlsx"
    wb.save(temp_path)
    try:
        check_wb = load_workbook(temp_path, read_only=True, data_only=True)
        check_ws = check_wb["Orgs"]
        first_data_rows = list(check_ws.iter_rows(min_row=2, max_row=min(check_ws.max_row, 6), values_only=True))
        valid_names = [row[0] for row in first_data_rows if row and row[0] and str(row[0]).strip()]
        if check_ws.max_row < 2 or not valid_names:
            check_wb.close()
            raise RuntimeError(
                "Workbook verification failed: Orgs sheet has headers but no organization names. "
                "Original output, if any, was not replaced."
            )
        verified_rows = check_ws.max_row - 1
        check_wb.close()
        os.replace(temp_path, output_path)
        LOG.info("Workbook verification passed: %s organization rows in Orgs sheet.", verified_rows)
    except Exception:
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except OSError:
            pass
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape GSoC organization history into an Excel workbook.")
    parser.add_argument("--output", default="gsoc_organizations.xlsx", help="Output .xlsx path (default: gsoc_organizations.xlsx)")
    parser.add_argument("--delay", type=float, default=0.2, help="Delay between year-list requests, in seconds (default: 0.2)")
    parser.add_argument("--workers", type=int, default=4, help="Concurrent organization detail requests, 1-8 (default: 4)")
    parser.add_argument("--no-browser-fallback", action="store_true", help="Do not use Playwright for paginated organization lists")
    parser.add_argument("--current-year", type=int, default=None, help="Override the detected calendar year (useful for testing)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
    current_year = args.current_year or dt.date.today().year
    requested_output_path = os.path.abspath(args.output)
    LOG.info("Output destination for this run: %s", requested_output_path)
    scraper = GSoCScraper(
        delay=args.delay,
        workers=args.workers,
        browser_fallback=not args.no_browser_fallback,
    )
    year_results: dict[int, YearResult] = {}
    scrape_log: list[dict[str, str]] = []
    try:
        LOG.info("Checking the current year's GSoC organization page: %s", current_year)
        current_result = scraper.fetch_listing(current_year)
        year_results[current_year] = current_result
        LOG.info(
            "Current-year listing result: status=%s, organizations=%s, reported_total=%s%s",
            current_result.status, len(current_result.organizations), current_result.total_reported,
            f", detail={current_result.error}" if current_result.error else "",
        )
        if (current_result.status in {"request_error", "incomplete", "empty_or_unrecognized"}
                or current_result.status.startswith("http_")):
            raise RuntimeError(
                f"Could not reliably verify the current-year list ({current_result.status}): "
                f"{current_result.error}. Refusing to guess the target year."
            )
        current_year_had_orgs = len(current_result.organizations) > 0
        baseline_year = current_year + 1 if current_year_had_orgs else current_year
        history_years = [baseline_year - offset for offset in range(1, 6)]
        LOG.info(
            "Current-year organizations found: %s. Reference year T=%s; scraping years %s.",
            current_year_had_orgs, baseline_year, ", ".join(map(str, history_years)),
        )

        # Fetch each requested historical year's list. The current-year result is
        # reused if it falls in the five-year comparison window.
        for year in history_years:
            if year in year_results:
                continue
            LOG.info("Fetching organization list for %s", year)
            result = scraper.fetch_listing(year)
            year_results[year] = result
            LOG.info(
                "Year %s listing result: status=%s, organizations=%s, reported_total=%s%s",
                year, result.status, len(result.organizations), result.total_reported,
                f", detail={result.error}" if result.error else "",
            )
            if result.status not in {"ok", "empty"}:
                scrape_log.append({
                    "year": str(year),
                    "status": result.status,
                    "url": result.url,
                    "details": result.error or "The year's organization list could not be verified.",
                })
            time.sleep(scraper.delay)

        # Merge organizations by normalized display name, keeping every year's
        # presence and using the most recent occurrence as the profile source.
        organizations: dict[str, dict[str, Any]] = {}
        for year in history_years:
            result = year_results.get(year)
            if result is None or result.status not in {"ok", "empty"}:
                continue
            for card in result.organizations:
                key = scraper._normalized_name(card.name) or card.slug.casefold()
                record = organizations.setdefault(key, {
                    "name": card.name,
                    "description": card.description,
                    "logo_url": card.logo_url,
                    "years": set(),
                    "card_by_year": {},
                })
                record["years"].add(year)
                record["card_by_year"][year] = card
                if year >= max(record["card_by_year"]):
                    if card.name:
                        record["name"] = card.name
                    if card.description:
                        record["description"] = card.description
                    if card.logo_url:
                        record["logo_url"] = card.logo_url

        LOG.info("Found %s unique organizations across the year lists.", len(organizations))
        if not organizations:
            raise RuntimeError("No organizations were collected. Check connectivity or the site's markup.")

        # Fetch one detail page per unique organization, preferring its most recent
        # appearance. This avoids re-fetching the same project for every historical
        # year. If HTTP HTML lacks Angular-rendered tags, fall back to Chromium in
        # the main thread; Playwright's synchronous API is not thread-safe.
        profile_jobs = {}
        with ThreadPoolExecutor(max_workers=scraper.workers) as executor:
            for key, record in organizations.items():
                record["profile_year"] = max(record["years"])
                record["profiles_by_year"] = {}
                card = record["card_by_year"][record["profile_year"]]
                profile_jobs[executor.submit(scraper.fetch_profile, card)] = (key, record["profile_year"], card)
            completed = 0
            total_profiles = len(profile_jobs)
            for future in as_completed(profile_jobs):
                key, profile_year, card = profile_jobs[future]
                try:
                    profile = future.result()
                except Exception as exc:
                    profile = OrgProfile(detail_url=card.detail_url, logo_url=card.logo_url, note=f"Profile scrape failed: {exc}")

                # The old script only used requests for detail pages. If that HTML
                # is an Angular shell, it silently leaves the long description,
                # tags, website and links empty even though the page renders them in Chrome.
                if ((not profile.long_description or not profile.technologies or not profile.topics)
                        and scraper.browser_fallback):
                    LOG.info("%s (%s): static profile is missing detail fields; retrying with Chromium.", card.name, profile_year)
                    browser_profile = scraper.fetch_profile_browser(card)
                    if browser_profile.long_description and len(browser_profile.long_description) > len(profile.long_description):
                        profile.long_description = browser_profile.long_description
                    if browser_profile.technologies and not profile.technologies:
                        profile.technologies = browser_profile.technologies
                    if browser_profile.topics and not profile.topics:
                        profile.topics = browser_profile.topics
                    if browser_profile.website_url and not profile.website_url:
                        profile.website_url = browser_profile.website_url
                    if browser_profile.contributor_guidance_url and not profile.contributor_guidance_url:
                        profile.contributor_guidance_url = browser_profile.contributor_guidance_url
                    if len(browser_profile.links) > len(profile.links):
                        profile.links = browser_profile.links
                    if browser_profile.note:
                        profile.note = (profile.note + " " + browser_profile.note).strip()

                organizations[key]["profiles_by_year"][profile_year] = profile
                organizations[key]["profile"] = profile
                if profile.note:
                    scrape_log.append({
                        "year": str(profile_year),
                        "status": "detail_note",
                        "url": card.detail_url,
                        "details": f"{card.name}: {profile.note}",
                    })
                completed += 1
                if completed % 25 == 0 or completed == total_profiles:
                    LOG.info("Scraped unique organization profiles: %s/%s", completed, total_profiles)

        with_tags = sum(
            1 for record in organizations.values()
            if record["profile"].technologies or record["profile"].topics
        )
        with_links = sum(1 for record in organizations.values() if record["profile"].links)
        LOG.info(
            "Detail extraction totals: %s/%s organizations have technology/topic tags; %s/%s have links.",
            with_tags, len(organizations), with_links, len(organizations),
        )
        if with_tags == 0:
            LOG.warning(
                "No profile technology/topic data was extracted. The workbook will still include organization names and year presence, "
                "but check network access/Chromium and the Detail Notes column."
            )

        output_path = requested_output_path
        LOG.info("Writing workbook to: %s", output_path)
        export_workbook(
            output_path=output_path,
            baseline_year=baseline_year,
            current_year=current_year,
            current_year_had_orgs=current_year_had_orgs,
            year_results=year_results,
            organizations=organizations,
            scrape_log=scrape_log,
        )
        LOG.info("Saved Excel workbook: %s", output_path)
        LOG.info("Organization rows exported: %s", len(organizations))
        LOG.info("Sheets: Orgs, Scrape log")
        return 0
    finally:
        scraper.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrupted by user. Partial results may not have been exported.")
        raise SystemExit(130)
