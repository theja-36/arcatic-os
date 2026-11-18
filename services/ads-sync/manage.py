"""Research + campaign management through the official SDKs (google-ads 35.1.0 / API v26, facebook-business 26.0.4).

Safety rules enforced here, independent of the Arcatic API:
  * campaigns are always created PAUSED; activation is a separate call
  * the platform account currency must equal the campaign currency (budgets are never converted)
  * creation is retry-safe: objects are named with the Arcatic id and looked up before creating
Credentials arrive per request and are never stored or logged.
"""
from __future__ import annotations

import re

from build import google_plan, meta_plan

V = "v26"
TMP_BUDGET, TMP_CAMPAIGN, TMP_AD_GROUP = "-1", "-2", "-3"


# --------------------------------------------------------------------------- Google
def _google(body: dict):
    import os

    from google.ads.googleads.client import GoogleAdsClient

    cfg = {
        "developer_token": os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        "client_id": os.environ["GOOGLE_ADS_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_ADS_CLIENT_SECRET"],
        "refresh_token": body["refreshToken"],
        "use_proto_plus": True,
    }
    if body.get("loginCustomerId"):
        cfg["login_customer_id"] = re.sub(r"\D", "", str(body["loginCustomerId"]))
    return GoogleAdsClient.load_from_dict(cfg, version=V), re.sub(r"\D", "", str(body["customerId"]))


def google_keyword_ideas(body: dict) -> dict:
    client, customer = _google(body)
    svc = client.get_service("KeywordPlanIdeaService", version=V)
    gas = client.get_service("GoogleAdsService", version=V)
    gtc = client.get_service("GeoTargetConstantService", version=V)
    keywords = [str(k)[:80] for k in body.get("keywords", []) if str(k).strip()][:20]
    url = body.get("url") or None
    if not keywords and not url:
        raise ValueError("keywords or url required")
    req = client.get_type("GenerateKeywordIdeasRequest", version=V)
    req.customer_id = customer
    req.language = gas.language_constant_path(str(body.get("languageId") or "1000"))
    req.geo_target_constants = [gtc.geo_target_constant_path(str(i)) for i in body.get("locationIds", []) if re.fullmatch(r"\d+", str(i))][:10]
    req.include_adult_keywords = False
    req.keyword_plan_network = client.enums.KeywordPlanNetworkEnum.GOOGLE_SEARCH
    if keywords and url:
        req.keyword_and_url_seed.url = url
        req.keyword_and_url_seed.keywords.extend(keywords)
    elif keywords:
        req.keyword_seed.keywords.extend(keywords)
    else:
        req.url_seed.url = url
    ideas = []
    for i, idea in enumerate(svc.generate_keyword_ideas(request=req)):
        if i >= int(body.get("limit", 300)):
            break
        m = idea.keyword_idea_metrics
        ideas.append({
            "keyword": idea.text,
            "avgMonthlySearches": int(m.avg_monthly_searches) if m.avg_monthly_searches else None,
            "competition": m.competition.name,
            "competitionIndex": int(m.competition_index) if m.competition_index else None,
            "lowBidMinor": int(m.low_top_of_page_bid_micros // 10_000) if m.low_top_of_page_bid_micros else None,
            "highBidMinor": int(m.high_top_of_page_bid_micros // 10_000) if m.high_top_of_page_bid_micros else None,
        })
    return {"ideas": ideas}


def google_geo_suggest(body: dict) -> dict:
    client, _ = _google(body)
    gtc = client.get_service("GeoTargetConstantService", version=V)
    req = client.get_type("SuggestGeoTargetConstantsRequest", version=V)
    req.locale = str(body.get("locale") or "en")
    if body.get("countryCode"):
        req.country_code = str(body["countryCode"])[:2].upper()
    req.location_names.names.extend([str(body["query"])[:100]])
    out = []
    for s in gtc.suggest_geo_target_constants(req).geo_target_constant_suggestions:
        g = s.geo_target_constant
        out.append({"key": str(g.id), "name": g.name, "canonicalName": g.canonical_name, "type": g.target_type, "countryCode": g.country_code, "reach": int(s.reach or 0)})
    return {"locations": out[:20]}


def google_currency(client, customer: str) -> str:
    gas = client.get_service("GoogleAdsService", version=V)
    for batch in gas.search_stream(customer_id=customer, query="SELECT customer.currency_code FROM customer"):
        for row in batch.results:
            return row.customer.currency_code
    raise RuntimeError("could not read account currency")


def google_operations(client, customer: str, plan: dict) -> list:
    """MutateOperations for one atomic request. Pure SDK type building: no network."""
    budget_svc = client.get_service("CampaignBudgetService", version=V)
    campaign_svc = client.get_service("CampaignService", version=V)
    group_svc = client.get_service("AdGroupService", version=V)
    gas = client.get_service("GoogleAdsService", version=V)
    gtc = client.get_service("GeoTargetConstantService", version=V)
    budget_rn = budget_svc.campaign_budget_path(customer, TMP_BUDGET)
    campaign_rn = campaign_svc.campaign_path(customer, TMP_CAMPAIGN)
    group_rn = group_svc.ad_group_path(customer, TMP_AD_GROUP)
    E = client.enums
    ops = []

    op = client.get_type("MutateOperation", version=V)
    b = op.campaign_budget_operation.create
    b.resource_name, b.name, b.amount_micros = budget_rn, plan["budget"]["name"], plan["budget"]["amount_micros"]
    b.delivery_method = E.BudgetDeliveryMethodEnum.STANDARD
    b.explicitly_shared = False
    ops.append(op)

    op = client.get_type("MutateOperation", version=V)
    c = op.campaign_operation.create
    c.resource_name, c.name, c.campaign_budget = campaign_rn, plan["name"], budget_rn
    c.advertising_channel_type = E.AdvertisingChannelTypeEnum.SEARCH
    c.status = E.CampaignStatusEnum.PAUSED                       # never serves until activated
    c.target_spend.target_spend_micros = 0                       # Maximize clicks (as in Google's RSA example)
    c.network_settings.target_google_search = True
    c.network_settings.target_search_network = True
    c.network_settings.target_partner_search_network = False
    c.network_settings.target_content_network = False            # no Display expansion: spend stays on Search
    c.contains_eu_political_advertising = E.EuPoliticalAdvertisingStatusEnum.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING
    if plan.get("start"):
        c.start_date_time = plan["start"]
    if plan.get("end"):
        c.end_date_time = plan["end"]
    ops.append(op)

    for loc in plan["locations"]:
        op = client.get_type("MutateOperation", version=V)
        cc = op.campaign_criterion_operation.create
        cc.campaign = campaign_rn
        cc.location.geo_target_constant = gtc.geo_target_constant_path(loc)
        ops.append(op)
    for lang in plan["languages"]:
        op = client.get_type("MutateOperation", version=V)
        cc = op.campaign_criterion_operation.create
        cc.campaign = campaign_rn
        cc.language.language_constant = gas.language_constant_path(lang)
        ops.append(op)
    for text in plan["negatives"]:
        op = client.get_type("MutateOperation", version=V)
        cc = op.campaign_criterion_operation.create
        cc.campaign, cc.negative = campaign_rn, True
        cc.keyword.text, cc.keyword.match_type = text, E.KeywordMatchTypeEnum.BROAD
        ops.append(op)

    op = client.get_type("MutateOperation", version=V)
    g = op.ad_group_operation.create
    g.resource_name, g.name, g.campaign = group_rn, f"{plan['name']} ad group", campaign_rn
    g.status = E.AdGroupStatusEnum.ENABLED
    g.type_ = E.AdGroupTypeEnum.SEARCH_STANDARD
    ops.append(op)

    op = client.get_type("MutateOperation", version=V)
    a = op.ad_group_ad_operation.create
    a.ad_group, a.status = group_rn, E.AdGroupAdStatusEnum.ENABLED
    a.ad.final_urls.append(plan["ad"]["final_url"])
    for text in plan["ad"]["headlines"]:
        t = client.get_type("AdTextAsset", version=V)
        t.text = text
        a.ad.responsive_search_ad.headlines.append(t)
    for text in plan["ad"]["descriptions"]:
        t = client.get_type("AdTextAsset", version=V)
        t.text = text
        a.ad.responsive_search_ad.descriptions.append(t)
    if plan["ad"].get("path1"):
        a.ad.responsive_search_ad.path1 = plan["ad"]["path1"]
    if plan["ad"].get("path2"):
        a.ad.responsive_search_ad.path2 = plan["ad"]["path2"]
    ops.append(op)

    for k in plan["keywords"]:
        op = client.get_type("MutateOperation", version=V)
        kc = op.ad_group_criterion_operation.create
        kc.ad_group, kc.status = group_rn, E.AdGroupCriterionStatusEnum.ENABLED
        kc.keyword.text = k["text"]
        kc.keyword.match_type = getattr(E.KeywordMatchTypeEnum, k["match"])
        ops.append(op)
    return ops


def _google_find(client, customer: str, name: str):
    gas = client.get_service("GoogleAdsService", version=V)
    safe = name.replace("\\", "\\\\").replace("'", "\\'")
    q = f"SELECT campaign.id, campaign.status, campaign_budget.resource_name FROM campaign WHERE campaign.name = '{safe}' AND campaign.status != 'REMOVED'"
    for batch in gas.search_stream(customer_id=customer, query=q):
        for row in batch.results:
            return {"campaignId": str(row.campaign.id), "budgetResourceName": row.campaign_budget.resource_name, "reused": True}
    return None


def google_create(body: dict) -> dict:
    plan = google_plan(body["campaign"])
    client, customer = _google(body)
    currency = google_currency(client, customer)
    if currency != body["campaign"].get("currency", "INR"):
        raise ValueError(f"ad account currency is {currency}, campaign currency is {body['campaign'].get('currency', 'INR')}")
    found = _google_find(client, customer, plan["name"])
    if found:
        return {**found, "currency": currency}
    gas = client.get_service("GoogleAdsService", version=V)
    resp = gas.mutate(customer_id=customer, mutate_operations=google_operations(client, customer, plan))  # atomic: all or nothing
    r = resp.mutate_operation_responses
    campaign_rn = r[1].campaign_result.resource_name
    return {"campaignId": campaign_rn.split("/")[-1], "campaignResourceName": campaign_rn, "budgetResourceName": r[0].campaign_budget_result.resource_name, "currency": currency, "reused": False}


def google_update(body: dict) -> dict:
    from google.api_core import protobuf_helpers

    client, customer = _google(body)
    E = client.enums
    done = []
    if body.get("dailyBudgetMinor"):
        svc = client.get_service("CampaignBudgetService", version=V)
        op = client.get_type("CampaignBudgetOperation", version=V)
        b = op.update
        b.resource_name = str(body["budgetResourceName"])
        b.amount_micros = int(body["dailyBudgetMinor"]) * 10_000
        client.copy_from(op.update_mask, protobuf_helpers.field_mask(None, b._pb))
        svc.mutate_campaign_budgets(customer_id=customer, operations=[op])
        done.append("budget")
    if body.get("status"):
        status = {"active": E.CampaignStatusEnum.ENABLED, "paused": E.CampaignStatusEnum.PAUSED}[body["status"]]
        svc = client.get_service("CampaignService", version=V)
        op = client.get_type("CampaignOperation", version=V)
        c = op.update
        c.resource_name = svc.campaign_path(customer, re.sub(r"\D", "", str(body["campaignId"])))
        c.status = status
        client.copy_from(op.update_mask, protobuf_helpers.field_mask(None, c._pb))
        svc.mutate_campaigns(customer_id=customer, operations=[op])
        done.append(f"status:{body['status']}")
    return {"done": done}


# --------------------------------------------------------------------------- Meta
def _meta(body: dict):
    from facebook_business.api import FacebookAdsApi

    return FacebookAdsApi.init(access_token=body["accessToken"])


def _act(v) -> str:
    v = str(v)
    return v if v.startswith("act_") else f"act_{re.sub(r'[^0-9]', '', v)}"


def meta_search(body: dict) -> dict:
    from facebook_business.adobjects.targetingsearch import TargetingSearch

    api = _meta(body)
    kind = body.get("kind")
    T = TargetingSearch.TargetingSearchTypes
    if kind not in ("interest", "geo"):
        raise ValueError("kind must be interest or geo")
    params = {"q": str(body["q"])[:100], "type": T.interest if kind == "interest" else T.geolocation, "limit": 25}
    out = []
    for r in TargetingSearch.search(params=params, api=api):
        d = r.export_all_data() if hasattr(r, "export_all_data") else dict(r)
        if kind == "interest":
            out.append({"id": str(d.get("id")), "name": d.get("name"), "audienceLower": d.get("audience_size_lower_bound"), "audienceUpper": d.get("audience_size_upper_bound"), "path": d.get("path")})
        elif d.get("type") in ("country", "region", "city"):
            key = d.get("country_code") if d.get("type") == "country" else str(d.get("key"))
            out.append({"key": key, "name": d.get("name"), "type": d.get("type"), "countryCode": d.get("country_code"), "region": d.get("region")})
    return {"results": out}


def meta_create(body: dict) -> dict:
    from facebook_business.adobjects.adaccount import AdAccount
    from facebook_business.adobjects.campaign import Campaign

    plan = meta_plan(body["campaign"])
    api = _meta(body)
    acct = AdAccount(_act(body["adAccountId"]), api=api)
    currency = acct.api_get(fields=[AdAccount.Field.currency]).get("currency")
    if currency != body["campaign"].get("currency", "INR"):
        raise ValueError(f"ad account currency is {currency}, campaign currency is {body['campaign'].get('currency', 'INR')}")
    # a retry after a partial failure: our PAUSED campaign with this name is removed and rebuilt
    for c in acct.get_campaigns(fields=[Campaign.Field.name], params={"effective_status": ["PAUSED"], "limit": 200}):
        if c.get("name") == plan["name"]:
            Campaign(c["id"], api=api).api_delete()
    created = []
    try:
        camp = acct.create_campaign(params=plan["campaign"])
        created.append(camp)
        adset = acct.create_ad_set(params={**plan["adset"], "campaign_id": camp["id"]})
        creative = acct.create_ad_creative(params=plan["creative"])
        ad = acct.create_ad(params={**plan["ad"], "adset_id": adset["id"], "creative": {"creative_id": creative["id"]}})
    except Exception:
        for obj in created:  # deleting the campaign removes its ad sets and ads
            try:
                Campaign(obj["id"], api=api).api_delete()
            except Exception:
                pass
        raise
    return {"campaignId": camp["id"], "adSetId": adset["id"], "creativeId": creative["id"], "adId": ad["id"], "currency": currency, "reused": False}


def meta_update(body: dict) -> dict:
    from facebook_business.adobjects.adset import AdSet
    from facebook_business.adobjects.campaign import Campaign

    api = _meta(body)
    done = []
    if body.get("dailyBudgetMinor"):
        AdSet(str(body["adSetId"]), api=api).api_update(params={"daily_budget": int(body["dailyBudgetMinor"])})
        done.append("budget")
    if body.get("status"):
        status = {"active": "ACTIVE", "paused": "PAUSED"}[body["status"]]
        Campaign(str(body["campaignId"]), api=api).api_update(params={"status": status})
        done.append(f"status:{body['status']}")
    return {"done": done}
