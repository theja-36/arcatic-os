"""SDK calls. Imports are lazy so the server starts (and tests run) without the SDKs installed."""
from __future__ import annotations

import os
import re

from normalize import google_row, meta_row

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _dates(body):
    f, t = body.get("from", ""), body.get("to", "")
    if not (DATE.match(f) and DATE.match(t)):
        raise ValueError("from/to must be YYYY-MM-DD")
    return f, t


def google_ads(body: dict) -> dict:
    from google.ads.googleads.client import GoogleAdsClient  # official SDK (google-ads-python)

    f, t = _dates(body)
    customer = re.sub(r"\D", "", str(body["customerId"]))
    cfg = {
        "developer_token": os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        "client_id": os.environ["GOOGLE_ADS_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_ADS_CLIENT_SECRET"],
        "refresh_token": body["refreshToken"],
        "use_proto_plus": True,
    }
    if body.get("loginCustomerId"):
        cfg["login_customer_id"] = re.sub(r"\D", "", str(body["loginCustomerId"]))
    client = GoogleAdsClient.load_from_dict(cfg, version="v26")
    service = client.get_service("GoogleAdsService", version="v26")
    query = (
        "SELECT customer.currency_code, campaign.id, campaign.name, segments.date, metrics.impressions, metrics.clicks, "
        "metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.video_trueview_views "
        f"FROM campaign WHERE segments.date BETWEEN '{f}' AND '{t}'"
    )
    rows, currency = [], None
    for batch in service.search_stream(customer_id=customer, query=query):
        for row in batch.results:
            currency = currency or row.customer.currency_code
            rows.append(google_row(row))
    return {"rows": rows, "currency": currency}


def meta(body: dict) -> dict:
    from facebook_business.api import FacebookAdsApi  # official SDK (facebook-python-business-sdk)
    from facebook_business.adobjects.adaccount import AdAccount
    from facebook_business.adobjects.adsinsights import AdsInsights

    f, t = _dates(body)
    account = str(body["adAccountId"])
    account = account if account.startswith("act_") else f"act_{re.sub(r'[^0-9]', '', account)}"
    api = FacebookAdsApi.init(access_token=body["accessToken"])
    F = AdsInsights.Field
    fields = [F.campaign_id, F.campaign_name, F.date_start, F.impressions, F.clicks, F.spend, F.reach, F.actions, F.action_values, F.video_play_actions, F.account_currency]
    params = {"level": AdsInsights.Level.campaign, "time_increment": 1, "time_range": {"since": f, "until": t}}
    rows, currency = [], None
    for r in AdAccount(account, api=api).get_insights(fields=fields, params=params):
        d = r.export_all_data()
        currency = currency or d.get("account_currency")
        rows.append(meta_row(d))
    return {"rows": rows, "currency": currency}
