"""Pure payload builders for campaign creation (no SDK imports) so they are unit-testable offline.

Arcatic sends a validated campaign; these functions turn it into exactly what the official SDKs
need. Every object Arcatic creates starts PAUSED at the campaign level; nothing serves until a
separately approved "activate" call.
"""
from __future__ import annotations

import re

META_GENDERS = {"male": 1, "female": 2}
META_OBJECTIVES = {
    "traffic": {"objective": "OUTCOME_TRAFFIC", "optimization_goal": "LINK_CLICKS"},
    "awareness": {"objective": "OUTCOME_AWARENESS", "optimization_goal": "REACH"},
}
GOOGLE_MATCH = {"BROAD", "PHRASE", "EXACT"}
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def tag_name(name: str, arcatic_id: str) -> str:
    """Platform object name carrying the Arcatic id, used to find a campaign again after a retry."""
    return f"{name.strip()[:200]} [arc:{arcatic_id[:8]}]"


def _req(cond: bool, msg: str):
    if not cond:
        raise ValueError(msg)


def _common(c: dict):
    _req(isinstance(c.get("id"), str) and len(c["id"]) >= 8, "campaign.id required")
    _req(isinstance(c.get("dailyBudgetMinor"), int) and c["dailyBudgetMinor"] > 0, "dailyBudgetMinor must be a positive integer")
    _req(str(c.get("landingUrl", "")).startswith("https://"), "landingUrl must be https")
    for k in ("startDate", "endDate"):
        _req(c.get(k) in (None, "") or bool(DATE.match(str(c[k]))), f"{k} must be YYYY-MM-DD")


def google_plan(c: dict) -> dict:
    """Arcatic Google campaign → plan for an atomic GoogleAdsService.mutate (budget, campaign, criteria, ad group, RSA, keywords)."""
    _common(c)
    cr, au = c.get("creative") or {}, c.get("audience") or {}
    heads = [h.strip() for h in cr.get("headlines", []) if h and h.strip()]
    descs = [d.strip() for d in cr.get("descriptions", []) if d and d.strip()]
    _req(3 <= len(heads) <= 15, "3–15 headlines required")
    _req(2 <= len(descs) <= 4, "2–4 descriptions required")
    kws = [k for k in au.get("keywords", []) if k.get("text")]
    _req(len(kws) >= 1, "at least one keyword")
    locs = [str(l["key"]) for l in au.get("locations", []) if re.fullmatch(r"\d+", str(l.get("key", "")))]
    _req(len(locs) >= 1, "at least one Google location (geo target constant id)")
    name = tag_name(c["name"], c["id"])
    return {
        "name": name,
        "budget": {"name": f"{name} budget", "amount_micros": int(c["dailyBudgetMinor"]) * 10_000},
        "start": c["startDate"].replace("-", "") + " 00:00:00" if c.get("startDate") else None,
        "end": c["endDate"].replace("-", "") + " 23:59:59" if c.get("endDate") else None,
        "locations": locs,
        "languages": [str(x) for x in au.get("languageIds") or [] if re.fullmatch(r"\d+", str(x))],
        "negatives": [n.strip() for n in au.get("negativeKeywords", []) if n and n.strip()][:50],
        "keywords": [{"text": k["text"].strip()[:80], "match": k.get("match", "PHRASE") if k.get("match") in GOOGLE_MATCH else "PHRASE"} for k in kws][:50],
        "ad": {"final_url": c["landingUrl"], "headlines": heads, "descriptions": descs, "path1": cr.get("path1") or None, "path2": cr.get("path2") or None},
    }


def meta_plan(c: dict) -> dict:
    """Arcatic Meta campaign → params for create_campaign / create_ad_set / create_ad_creative / create_ad."""
    _common(c)
    obj = META_OBJECTIVES.get(c.get("objective"))
    _req(obj is not None, "objective must be traffic or awareness")
    _req(bool(re.fullmatch(r"\d+", str(c.get("pageId") or ""))), "a Facebook Page id is required (ad account settings)")
    _req(str(c.get("imageUrl", "")).startswith("https://"), "imageUrl (https) required")
    cr, au = c.get("creative") or {}, c.get("audience") or {}
    _req(bool(cr.get("primaryText")) and bool(cr.get("headline")), "primaryText and headline required")
    countries, regions, cities = [], [], []
    for l in au.get("locations", []):
        t, k = l.get("type"), str(l.get("key", ""))
        if t == "country" and re.fullmatch(r"[A-Z]{2}", k):
            countries.append(k)
        elif t == "region" and k:
            regions.append({"key": k})
        elif t == "city" and k:
            cities.append({"key": k})
    _req(bool(countries or regions or cities), "at least one location")
    geo = {**({"countries": countries} if countries else {}), **({"regions": regions} if regions else {}), **({"cities": cities} if cities else {})}
    special = [s for s in c.get("specialAdCategories") or [] if s in {"CREDIT", "EMPLOYMENT", "FINANCIAL_PRODUCTS_SERVICES", "HOUSING", "ONLINE_GAMBLING_AND_GAMING"}]
    targeting: dict = {"geo_locations": geo, "age_min": int(au.get("ageMin", 18)), "age_max": int(au.get("ageMax", 65))}
    genders = [META_GENDERS[g] for g in au.get("genders", []) if g in META_GENDERS]
    if genders and len(genders) < 2:
        targeting["genders"] = genders
    interests = [{"id": str(i["id"]), "name": str(i.get("name", ""))} for i in au.get("interests", []) if i.get("id")]
    if interests:
        targeting["flexible_spec"] = [{"interests": interests}]
    if special:  # special ad categories: no age / gender narrowing
        targeting.update({"age_min": 18, "age_max": 65})
        targeting.pop("genders", None)
    name = tag_name(c["name"], c["id"])
    adset = {
        "name": f"{name} ad set", "daily_budget": int(c["dailyBudgetMinor"]), "billing_event": "IMPRESSIONS",
        "optimization_goal": obj["optimization_goal"], "bid_strategy": "LOWEST_COST_WITHOUT_CAP", "targeting": targeting, "status": "ACTIVE",
    }
    tz = str(c.get("timezoneOffset") or "+0530")  # workspace offset, sent by Arcatic
    _req(bool(re.fullmatch(r"[+-]\d{4}", tz)), "timezoneOffset must look like +0530")
    if c.get("startDate"):
        adset["start_time"] = f"{c['startDate']}T00:00:00{tz}"
    if c.get("endDate"):
        adset["end_time"] = f"{c['endDate']}T23:59:59{tz}"
    link = {"link": c["landingUrl"], "message": cr["primaryText"], "name": cr["headline"], "picture": c["imageUrl"],
            "call_to_action": {"type": cr.get("cta") or "LEARN_MORE", "value": {"link": c["landingUrl"]}}}
    if cr.get("description"):
        link["description"] = cr["description"]
    story = {"page_id": str(c["pageId"]), "link_data": link}
    if c.get("instagramUserId"):
        story["instagram_user_id"] = str(c["instagramUserId"])
    return {
        "name": name,
        "campaign": {"name": name, "objective": obj["objective"], "status": "PAUSED", "special_ad_categories": special, "is_adset_budget_sharing_enabled": False},
        "adset": adset,
        "creative": {"name": f"{name} creative", "object_story_spec": story},
        "ad": {"name": f"{name} ad", "status": "ACTIVE"},
    }
